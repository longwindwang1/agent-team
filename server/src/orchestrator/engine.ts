import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import notifier from 'node-notifier'
import type { AgentId, ApprovalRow, MessageRow, ProjectRow } from '../types'
import { ROOT_DIR, WORKSPACES_DIR } from '../lib/paths'
import {
  activeProject,
  addMessage,
  currentProject,
  getProject,
  listAgents,
  listTasks,
  setActiveProject,
  setProjectStatus,
  updateProjectBudget,
  usageSummary,
} from '../db/dao'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { git, initProjectRepo } from '../lib/git'
import { budgetOnlyApprovals, getSetting, getSettingNumber, roleEnabled } from '../settings'
import { AgentPool } from './agentPool'
import { ApprovalGate } from './approvalGate'
import { MeetingRunner } from './meetingRunner'
import { parseJsonBlock } from '../lib/json'
import { TaskFlow } from './taskFlow'
import { Reporter } from './reporter'
import { archiveLesson, distillProject } from './memory'
import { designLoopNext } from './loopControl'
import { teamLang, tx } from './texts'
import { existsSync, writeFileSync } from 'node:fs'

const PROMPTS_DIR = path.join(ROOT_DIR, 'server', 'prompts')
const ALL_AGENTS: AgentId[] = ['coordinator', 'architect', 'frontend', 'backend', 'reviewer', 'qa', 'challenger', 'ba', 'devops', 'scribe']

function enabledAgents(): AgentId[] {
  return ALL_AGENTS.filter((id) => roleEnabled(id))
}

/** 需要质疑者出参谋意见的审批类别 */
const ADVISABLE_APPROVAL = /依赖|选型|技术栈|框架|第三方|install|dependen|library|framework|tech stack|package/i

function loadPrompt(id: AgentId): string {
  const dir = path.join(PROMPTS_DIR, teamLang())
  const role = readFileSync(path.join(dir, `${id}.md`), 'utf-8')
  const common = readFileSync(path.join(dir, 'common.md'), 'utf-8')
  return `${role}\n\n${common}`
}

export function projectDir(projectId: number): string {
  return path.join(WORKSPACES_DIR, `project-${projectId}`)
}

/** 发一条消息并广播，返回记录；taskId/projectId 非空时归入对应对话线程 */
export function postMessage(meetingId: number | null, from: string, content: string, to?: string, taskId?: number | null, projectId?: number | null): MessageRow {
  const row = addMessage({ meeting_id: meetingId, task_id: taskId ?? null, project_id: projectId ?? null, from_agent: from, to_agent: to ?? null, content })
  broadcast('message', row)
  return row
}

const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))])

class Engine {
  readonly gate = new ApprovalGate()
  private pool: AgentPool | null = null
  private meetingRunner: MeetingRunner | null = null
  private reporter = new Reporter(() => this.pool)
  private flow: TaskFlow | null = null
  private flowActive = false

  /** 服务启动时调用：恢复孤儿项目 + 启动汇报调度 + 审批参谋 */
  init(): void {
    // 审批参谋：装依赖/技术选型类审批，质疑者 3 分钟内给参考意见附在卡片上
    this.gate.adviser = async (req) => {
      if (getSetting('challenge_approvals') !== 'on' || !roleEnabled('challenger')) return null
      if (!this.pool?.has('challenger')) return null
      if (!ADVISABLE_APPROVAL.test(`${req.title}\n${req.context ?? ''}`)) return null
      try {
        const t = tx()
        return await withTimeout(
          this.pool.ask('challenger', t.adviser(req.requested_by, req.title, req.context ?? ''), {
            statusDetail: t.stAdvising,
            timeoutMs: 3 * 60_000,
          }),
          3 * 60_000,
          'adviser timeout',
        )
      } catch {
        return null
      }
    }

    const project = currentProject()
    if (project && project.status === 'running') {
      // 服务重启导致会话丢失，标记为暂停等用户点继续
      setProjectStatus(project.id, 'paused')
      logEvent('project.orphaned', null, { id: project.id, note: '服务重启，项目已暂停，可在仪表盘点击继续' })
    }
    this.reporter.schedule()
  }

  getPool(): AgentPool {
    if (!this.pool) {
      this.pool = new AgentPool(this.gate, loadPrompt, {
        gate: this.gate,
        onDirectMessage: (from, to, content) => {
          logEvent('dm.delivered', from, { to, preview: content.slice(0, 80) })
        },
        askAgent: async (from, to, content) => {
          // 私信同步答复：仅协调者/架构师作为被询问方，避免互相等待死锁
          if (!this.pool || !this.pool.has(to) || !['coordinator', 'architect'].includes(to) || from === to) return null
          try {
            const t = tx()
            const reply = await withTimeout(
              this.pool.ask(to, t.dmAnswer(from, content), { statusDetail: t.stReplyDm(from) }),
              5 * 60_000,
              'dm reply timeout',
            )
            postMessage(null, to, reply, from)
            return reply
          } catch {
            return null
          }
        },
      })
    }
    return this.pool
  }

  private getMeetingRunner(): MeetingRunner {
    if (!this.meetingRunner) this.meetingRunner = new MeetingRunner(this.getPool())
    return this.meetingRunner
  }

  // ---------------- 项目主流程 ----------------

  async startProject(projectId: number): Promise<void> {
    void this.runProjectFlow(projectId, 'start')
  }

  async resumeProject(projectId: number): Promise<void> {
    setProjectStatus(projectId, 'running')
    broadcast('project', getProject(projectId))
    logEvent('project.resumed', null, { id: projectId })
    if (!this.flowActive) void this.runProjectFlow(projectId, 'resume')
  }

  async pauseProject(projectId: number): Promise<void> {
    setProjectStatus(projectId, 'paused')
    broadcast('project', getProject(projectId))
    logEvent('project.paused', null, { id: projectId })
  }

  private async runProjectFlow(projectId: number, mode: 'start' | 'resume'): Promise<void> {
    const project = getProject(projectId)
    if (!project) return
    if (this.flowActive) return
    this.flowActive = true
    try {
      setProjectStatus(projectId, 'running')
      broadcast('project', getProject(projectId))
      if (mode === 'start') logEvent('project.started', null, { id: projectId, name: project.name })

      // 1. 基础设施
      const dir = projectDir(projectId)
      mkdirSync(dir, { recursive: true })
      await initProjectRepo(dir, project.name, project.requirement)

      // 2. 启动启用角色的会话（重启后自动带 resume 恢复上下文；新项目先关掉旧项目的会话）
      const pool = this.getPool()
      if (mode === 'start') await pool.closeAll()
      const resumeIds = new Map(listAgents().filter((a) => a.session_id).map((a) => [a.id, a.session_id!] as const))
      pool.startAgents(dir, enabledAgents(), mode === 'resume' ? resumeIds : undefined)

      // 3. kickoff（已有任务说明开过会了，跳过）
      let tasks = listTasks(projectId)
      if (tasks.length === 0) {
        // 3a. BA 需求分析：一句话需求 → PRD（含向用户澄清开放问题）
        const prd = await this.runRequirementAnalysis(project, dir)
        const kickoff = await this.getMeetingRunner().runKickoff(project, prd ?? undefined)
        tasks = kickoff.tasks
        if (tasks.length === 0) {
          throw new Error('kickoff 会议没有产出任何任务，请检查需求描述后重开项目')
        }
        // 4. 架构师写设计文档
        await this.writeDesignDoc(project, dir, kickoff.summary)
      }

      // 5. 预算守卫 + 任务流转
      if (!(await this.checkBudget(getProject(projectId)!))) return
      this.flow = new TaskFlow(pool, this.gate, projectId, dir, () => this.checkBudget(getProject(projectId)!))
      const { done, blocked } = await this.flow.runAll()

      // 6. 收尾
      if (done) {
        await this.finishProject(project)
      } else if (blocked.length > 0) {
        await this.pauseProject(projectId)
        const blockedLines = blocked.map((b) => `#${b.id} ${b.title}: ${b.review_notes ?? b.status}`).join('\n')
        postMessage(null, 'system', tx().blockedPauseMsg(blockedLines))
        await this.reporter.generate('manual').catch(() => {})
        this.notify(tx().notifyPausedTitle, tx().notifyPausedMsg(blocked.length))
      }
    } catch (err) {
      const e = err as Error
      setProjectStatus(projectId, 'failed')
      broadcast('project', getProject(projectId))
      logEvent('project.failed', null, { id: projectId, error: e.message.slice(0, 500) })
      this.notify(tx().notifyFailedTitle, e.message.slice(0, 100))
    } finally {
      this.flowActive = false
    }
  }

  /**
   * BA 需求分析阶段：产出 PRD、开放问题升级用户澄清、修订、落盘 repo/PRD.md 并提交。
   * BA 未启用或 PRD 已存在（重启续跑）时返回已有内容/null。
   */
  private async runRequirementAnalysis(project: ProjectRow, dir: string): Promise<string | null> {
    const repoDir = path.join(dir, 'repo')
    const prdPath = path.join(repoDir, 'PRD.md')
    if (existsSync(prdPath)) return readFileSync(prdPath, 'utf-8')
    if (!roleEnabled('ba')) return null
    const t = tx()
    const pool = this.getPool()

    type BaOut = { prd_markdown?: string; open_questions?: string[] }
    let out = parseJsonBlock<BaOut>(
      await pool.ask('ba', t.baPrd(project.requirement), { statusDetail: t.stBaPrd, timeoutMs: 10 * 60_000 }),
    )
    if (!out?.prd_markdown) {
      logEvent('json.retry', 'ba', { where: 'prd' })
      out = parseJsonBlock<BaOut>(await pool.ask('ba', t.jsonRetry(), { statusDetail: t.stBaPrd, timeoutMs: 10 * 60_000 })) ?? out
    }
    // 最多两轮向用户澄清开放问题
    for (let i = 0; i < 2; i++) {
      const questions = (out?.open_questions ?? []).filter((q) => q?.trim())
      if (questions.length === 0) break
      const numbered = questions.map((q, idx) => `${idx + 1}. ${q}`).join('\n')
      // 仅预算审批策略：不打断用户，BA 按合理假设继续；问题发频道，用户可随时在对话里补充
      if (budgetOnlyApprovals()) {
        postMessage(null, 'ba', t.baQuestionsSkipped(numbered))
        break
      }
      const decided = await this.gate.request({
        project_id: project.id,
        requested_by: 'ba',
        title: t.baQuestionsTitle,
        context: t.baQuestionsContext(numbered),
      })
      const answers = decided.comment?.trim()
      if (decided.status !== 'approved' || !answers) break // 用户驳回/未作答 → BA 按合理假设继续
      out = parseJsonBlock<BaOut>(await pool.ask('ba', t.baRevise(answers), { statusDetail: t.stBaRevise, timeoutMs: 10 * 60_000 })) ?? out
    }

    const prd = out?.prd_markdown?.trim()
    if (!prd) return null
    writeFileSync(prdPath, prd, 'utf-8')
    await git(['add', '-A'], repoDir)
    await git(['commit', '-m', 'docs: PRD (requirements)', '--allow-empty'], repoDir)
    logEvent('prd.committed', 'ba', {})
    postMessage(null, 'ba', prd.length > 1500 ? prd.slice(0, 1500) + '\n…' : prd)
    return prd
  }

  private async writeDesignDoc(project: ProjectRow, dir: string, meetingSummary: string): Promise<void> {
    const repoDir = path.join(dir, 'repo')
    const designPath = path.join(repoDir, 'DESIGN.md')
    await this.getPool().ask('architect', tx().designDoc(designPath, meetingSummary), {
      statusDetail: tx().stDesigning,
      timeoutMs: 15 * 60_000,
    })

    // 架构设计环：质疑者审 → 架构师修订 → 复审，循环到放行或上限
    await this.challengeDesign(project, repoDir)

    // 设计文档入库（main 分支），之后创建的任务 worktree 都能看到
    await git(['add', '-A'], repoDir)
    await git(['commit', '-m', 'docs: 架构设计文档 (DESIGN.md)', '--allow-empty'], repoDir)
    logEvent('design.committed', 'architect', {})
  }

  /** 架构设计环：提案 → 质疑 → 修订 → 再质疑，循环到质疑者放行或 design_max_cycles 兜底 */
  private async challengeDesign(project: ProjectRow, repoDir: string): Promise<void> {
    if (getSetting('challenge_design') !== 'on' || !roleEnabled('challenger')) return
    const pool = this.getPool()
    if (!pool.has('challenger')) return
    const t = tx()
    const designPath = path.join(repoDir, 'DESIGN.md')
    const maxCycles = Math.max(1, getSettingNumber('design_max_cycles'))
    for (let cycle = 1; ; cycle++) {
      // 每轮质疑者重读盘上的 DESIGN.md（修订直接写盘，提交在循环之后）；问询失败视为放行（fail-open）
      const critique = await pool
        .ask('challenger', cycle === 1 ? t.designChallenge(designPath) : t.designRechallenge(designPath, cycle), {
          statusDetail: t.stChallengingDesign,
          timeoutMs: 10 * 60_000,
        })
        .catch(() => null)
      const verdict = critique ? parseJsonBlock<{ pass?: boolean; issues?: Array<{ concern: string; suggestion?: string }> }>(critique) : null
      const issues = verdict?.issues ?? []
      const issuesText = issues.map((i) => `- ${i.concern}${i.suggestion ? ` → ${i.suggestion}` : ''}`).join('\n')
      const next = designLoopNext({ pass: verdict?.pass ?? null, issueCount: issues.length, cycle, maxCycles })
      if (next === 'pass') {
        logEvent('challenge.design_pass', 'challenger', { cycle })
        return
      }
      if (next === 'cap') {
        // 达上限放行 + 告警（不走审批门：budget_only 下自动批无意义，rework 又会打扰用户）；
        // 归档进团队记忆，工程师开发简报里经 lessonsForBrief 继承这些顾虑
        postMessage(null, 'challenger', t.designUnresolvedMsg(issuesText))
        archiveLesson({ project_id: project.id, source_type: 'manual', tags: 'design', content: issuesText.slice(0, 800), created_by: 'challenger' })
        logEvent('challenge.design_cap', 'challenger', { cycles: maxCycles, issues: issues.length })
        return
      }
      // revise：意见发给架构师修订，下一轮复审修订版
      postMessage(null, 'challenger', t.designIssuesMsg(issuesText), 'architect')
      logEvent('challenge.design', 'challenger', { cycle, issues: issues.length })
      const revision = await pool.ask('architect', t.designRevision(issuesText, designPath), {
        statusDetail: t.stRevisingDesign,
        timeoutMs: 15 * 60_000,
      })
      postMessage(null, 'architect', t.designRevisionMsg(revision), 'challenger')
    }
  }

  private async finishProject(project: ProjectRow): Promise<void> {
    const t = tx()
    setProjectStatus(project.id, 'done')
    broadcast('project', getProject(project.id))
    logEvent('project.done', null, { id: project.id })
    const closing = await this.getPool()
      .ask('coordinator', t.delivery(), { statusDetail: t.stDelivery, timeoutMs: 5 * 60_000 })
      .catch(() => '')
    if (closing) postMessage(null, 'coordinator', t.deliveryMsg(closing))
    await distillProject(this.getPool(), project).catch(() => {})
    await this.reporter.generate('manual').catch(() => {})
    this.notify(t.notifyDoneTitle, t.notifyDoneMsg(project.name))
    // 项目结束统一回收会话（project_end 档）：进行期间保热、结束才释放
    if (getSetting('session_recycle') === 'project_end') this.pool?.recycleAllIdle()
  }

  /** 预算守卫：超预算时请用户追加或暂停。只统计本项目启动后的成本——usageSummary() 全量是跨项目累计，拿它对比会让新项目一启动就"超支"死循环 */
  async checkBudget(project: ProjectRow): Promise<boolean> {
    const cost = usageSummary(project.created_at).cost_usd
    if (cost < project.budget_usd) return true
    const t = tx()
    const decided = await this.gate.request({
      project_id: project.id,
      requested_by: 'coordinator',
      title: t.budgetTitle(cost, project.budget_usd),
      context: t.budgetContext,
      options: [t.budgetAdd5, t.budgetAdd20, t.budgetPause],
      recommendation: t.budgetAdd5,
      kind: 'budget',
    })
    const add = decided.decision === t.budgetAdd20 || decided.decision?.includes('$20') ? 20 : decided.decision === t.budgetAdd5 || decided.decision?.includes('$5') ? 5 : 0
    if (decided.status === 'approved' && add > 0) {
      updateProjectBudget(project.id, project.budget_usd + add)
      broadcast('project', getProject(project.id))
      logEvent('budget.increased', null, { add })
      return true
    }
    await this.pauseProject(project.id)
    return false
  }

  /**
   * 用户随时对话：进度询问/简单问题由协调者即时回答；修改要求由协调者用 create_task(priority=1) 落成优先任务。
   * taskId 非空 = 任务级对话：注入该任务完整详情（状态/返工历史/依赖/所有权），消息归入任务线程。
   */
  async chatWithUser(message: string, taskId?: number | null, projectId?: number | null): Promise<string> {
    const t = tx()
    // 解析对话目标项目：显式选择优先，否则活动项目
    const project = (projectId != null ? getProject(projectId) : undefined) ?? activeProject()
    if (!project) {
      postMessage(null, 'coordinator', t.chatNoProject, 'user', taskId)
      return t.chatNoProject
    }
    postMessage(null, 'user', message, 'coordinator', taskId, project.id)
    // 是否是当前活动项目：非活动项目只能问、不能改（改需先激活，否则任务会错建到活动项目）
    const isActive = activeProject()?.id === project.id
    // 服务重启/切项目后 pool 未绑定该项目 → 懒启动协调者会话。
    // 不 resume：对话所需上下文全靠下方 prompt 注入（项目快照+任务档案），
    // 且旧 session_id 在重启/跨项目后往往已失效（No conversation found），新建会话最稳。
    if (!this.pool?.has('coordinator')) {
      this.getPool().startAgents(projectDir(project.id), ['coordinator'])
    }
    const tasks = listTasks(project.id)
    const cost = usageSummary(project.created_at).cost_usd
    const ctx = [
      `${project.name} [${project.status}] budget $${project.budget_usd} / spent $${cost.toFixed(2)}`,
      ...tasks.map(
        (k) => `#${k.id} [${k.status}] ${k.title}${k.assignee ? ` @${k.assignee}` : ''}${k.review_cycles > 0 ? ` (rework x${k.review_cycles})` : ''}${k.priority > 0 ? ' [user-priority]' : ''}`,
      ),
    ].join('\n')
    // 任务级对话：附上该任务的完整档案（详情、返工/审查意见、依赖与文件所有权）
    let taskDetail: string | null = null
    const focus = taskId != null ? tasks.find((k) => k.id === taskId) : undefined
    if (focus) {
      taskDetail = [
        `#${focus.id}「${focus.title}」 [${focus.status}] @${focus.assignee ?? '-'} priority=${focus.priority}`,
        `deps=${focus.deps} owns_files=${focus.owns_files} rework_cycles=${focus.review_cycles}`,
        `description: ${focus.description ?? '(none)'}`,
        focus.review_notes ? `latest notes/review: ${focus.review_notes.slice(0, 1200)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    }
    const reply = await this.getPool()
      .ask('coordinator', t.userChat(ctx, message, taskDetail, isActive ? null : project.name), { statusDetail: t.stChat, timeoutMs: 4 * 60_000 })
      .catch((e) => t.chatUnavailable((e as Error).message.slice(0, 120)))
    postMessage(null, 'coordinator', reply, 'user', taskId, project.id)
    logEvent('chat.replied', 'coordinator', { project: project.id, task: taskId ?? null, active: isActive, preview: reply.slice(0, 80) })
    // 若这轮在活动项目里新建了可执行任务、而项目当前不在运行 → 拉起调度让它落地
    if (isActive && project.status !== 'running') {
      const runnable = listTasks(project.id).some((k) => ['assigned', 'in_progress', 'review', 'qa', 'challenge', 'final'].includes(k.status))
      if (runnable) void this.resumeProject(project.id)
    }
    return reply
  }

  /** 把项目设为活动（跨项目切换）：更新指针；休眠项目则重新激活运行 */
  async activateProject(id: number): Promise<void> {
    setActiveProject(id)
    broadcast('project', getProject(id))
    logEvent('project.activated', null, { id })
    const p = getProject(id)
    if (p && p.status !== 'running') await this.resumeProject(id)
  }

  // ---------------- 外部回调 ----------------

  onApprovalDecided(approval: ApprovalRow): void {
    this.gate.resolve(approval)
  }

  async generateReportNow(): Promise<unknown | null> {
    return this.reporter.generate('manual')
  }

  onSettingsChanged(): void {
    this.reporter.schedule()
  }

  private notify(title: string, message: string): void {
    try {
      notifier.notify({ title, message, appID: 'Agent Team' })
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    this.reporter.stop()
    this.flow?.stop()
    await this.pool?.closeAll()
  }
}

export const engine = new Engine()
