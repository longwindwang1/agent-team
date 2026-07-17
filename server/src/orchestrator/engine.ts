import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import notifier from 'node-notifier'
import type { AgentId, ApprovalRow, MessageRow, ProjectRow } from '../types'
import { ROOT_DIR, WORKSPACES_DIR } from '../lib/paths'
import {
  activeProject,
  addMessage,
  getProject,
  listTasks,
  resetAgentStatuses,
  resumeIdsFor,
  runningProjects,
  setActiveProject,
  setProjectStatus,
  updateProjectBudget,
  usageSummary,
} from '../db/dao'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { git, initProjectRepo } from '../lib/git'
import { budgetOnlyApprovals, getSetting, getSettingNumber, maxConcurrentProjects, roleEnabled } from '../settings'
import { AgentPool } from './agentPool'
import { ApprovalGate } from './approvalGate'
import { MeetingRunner } from './meetingRunner'
import { parseJsonBlock } from '../lib/json'
import { TaskFlow } from './taskFlow'
import { Reporter } from './reporter'
import { archiveLesson, distillProject } from './memory'
import { designLoopNext } from './loopControl'
import { expireStaleApprovals, sweepOpenMeetings } from './recovery'
import { ensureLocalProxy, stopLocalProxy } from '../localproxy'
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

/** 每个项目一套编排设施：独立会话池（独立 cwd/记账）、会议执行器、任务流。多项目并发的基本单元 */
interface ProjectRuntime {
  readonly projectId: number
  readonly pool: AgentPool
  readonly meetingRunner: MeetingRunner
  flow: TaskFlow | null
  flowActive: boolean
}

class Engine {
  readonly gate = new ApprovalGate()
  private runtimes = new Map<number, ProjectRuntime>()
  private reporter = new Reporter((projectId) => this.runtimes.get(projectId)?.pool ?? null)

  /** 服务启动时调用：恢复孤儿项目 + 启动汇报调度 + 审批参谋 */
  init(): void {
    // 审批参谋：装依赖/技术选型类审批，质疑者 3 分钟内给参考意见附在卡片上（用发起方项目自己的质疑者）
    this.gate.adviser = async (req) => {
      if (getSetting('challenge_approvals') !== 'on' || !roleEnabled('challenger')) return null
      const pool = req.project_id != null ? this.runtimes.get(req.project_id)?.pool : undefined
      if (!pool?.has('challenger')) return null
      if (!ADVISABLE_APPROVAL.test(`${req.title}\n${req.context ?? ''}`)) return null
      try {
        const t = tx()
        return await withTimeout(
          pool.ask('challenger', t.adviser(req.requested_by, req.title, req.context ?? ''), {
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

    // 服务重启导致会话丢失：所有 running 项目标记暂停等用户点继续（多项目并发下可能不止一个）
    for (const project of runningProjects()) {
      setProjectStatus(project.id, 'paused')
      logEvent('project.orphaned', null, { id: project.id, note: '服务重启，项目已暂停，可在仪表盘点击继续' })
    }
    resetAgentStatuses() // 旧进程遗留的 working/thinking 是僵尸状态
    // 过期全部 pending 审批：新进程 resolvers 为空、原等待方已消亡——留着只会造成
    // "用户决定了但没人响应" + 重跑阶段再发起时 UI 出现重复卡片
    expireStaleApprovals()
    this.reporter.schedule()
  }

  /** 取（或建）项目的编排设施。协作工具/私信答复全部闭包绑定本项目的池 */
  private runtime(projectId: number): ProjectRuntime {
    const existing = this.runtimes.get(projectId)
    if (existing) return existing
    const pool = new AgentPool(this.gate, loadPrompt, {
      gate: this.gate,
      projectId,
      onDirectMessage: (from, to, content) => {
        logEvent('dm.delivered', from, { to, preview: content.slice(0, 80) })
      },
      askAgent: async (from, to, content) => {
        // 私信同步答复：仅协调者/架构师作为被询问方，避免互相等待死锁；只在本项目池内答复
        const p = this.runtimes.get(projectId)?.pool
        if (!p || !p.has(to) || !['coordinator', 'architect'].includes(to) || from === to) return null
        try {
          const t = tx()
          const reply = await withTimeout(
            p.ask(to, t.dmAnswer(from, content), { statusDetail: t.stReplyDm(from) }),
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
    const rt: ProjectRuntime = { projectId, pool, meetingRunner: new MeetingRunner(pool), flow: null, flowActive: false }
    this.runtimes.set(projectId, rt)
    return rt
  }

  /** 项目的 agent 实时状态叠加（/api/state 按活动项目显示；无 runtime 返回空） */
  agentStatusOverlay(projectId: number | null | undefined): Map<AgentId, { status: string; status_detail: string | null }> {
    if (projectId == null) return new Map()
    return this.runtimes.get(projectId)?.pool.statusSnapshot() ?? new Map()
  }

  // ---------------- 项目主流程 ----------------

  async startProject(projectId: number): Promise<void> {
    void this.runProjectFlow(projectId, 'start')
  }

  async resumeProject(projectId: number): Promise<void> {
    setProjectStatus(projectId, 'running')
    broadcast('project', getProject(projectId))
    logEvent('project.resumed', null, { id: projectId })
    if (!this.runtime(projectId).flowActive) void this.runProjectFlow(projectId, 'resume')
  }

  async pauseProject(projectId: number): Promise<void> {
    setProjectStatus(projectId, 'paused')
    broadcast('project', getProject(projectId))
    logEvent('project.paused', null, { id: projectId })
  }

  private async runProjectFlow(projectId: number, mode: 'start' | 'resume'): Promise<void> {
    const project = getProject(projectId)
    if (!project) return
    const rt = this.runtime(projectId)
    if (rt.flowActive) return // 同一项目不重入；不同项目各跑各的
    // 并发项目上限：每个项目十来个子进程会话，无上限会耗尽本机资源
    const cap = maxConcurrentProjects()
    const activeCount = [...this.runtimes.values()].filter((r) => r.flowActive).length
    if (activeCount >= cap) {
      setProjectStatus(projectId, 'paused')
      broadcast('project', getProject(projectId))
      postMessage(null, 'system', tx().concurrencyLimitMsg(project.name, cap), undefined, null, projectId)
      logEvent('project.concurrency_limit', null, { id: projectId, cap })
      return
    }
    rt.flowActive = true
    try {
      setProjectStatus(projectId, 'running')
      broadcast('project', getProject(projectId))
      if (mode === 'start') logEvent('project.started', null, { id: projectId, name: project.name })

      // 0. 崩溃恢复：作废服务中断遗留的 open 会议（会议不做断点续传——lastSeen 在内存已丢，
      //    作废后 kickoff 按 tasks.length===0 照旧重开；flowActive 保证此刻无并发 flow 在开会）
      sweepOpenMeetings(projectId)

      // 1. 基础设施
      const dir = projectDir(projectId)
      mkdirSync(dir, { recursive: true })
      await initProjectRepo(dir, project.name, project.requirement)

      // 1.5 有角色的模型走本机回环代理（如 OpenAI 经 LiteLLM）时，先确保代理活着（平台托管自动拉起）；
      //     失败不阻塞项目（官方/远程端点角色不受影响），但发频道显性告警——相关角色的任务会连接失败
      const proxy = await ensureLocalProxy()
      if (proxy.status === 'failed') {
        postMessage(null, 'system', tx().proxyFailedMsg(proxy.detail ?? ''))
      }

      // 2. 启动启用角色的会话（重启后自动带 resume 恢复上下文；重开项目先关掉本项目的残留会话）
      const pool = rt.pool
      if (mode === 'start') await pool.closeAll()
      pool.startAgents(dir, projectId, enabledAgents(), mode === 'resume' ? resumeIdsFor(projectId) : undefined)

      // 3. kickoff（已有任务说明开过会了，跳过）
      let tasks = listTasks(projectId)
      if (tasks.length === 0) {
        // 3a. BA 需求分析：一句话需求 → PRD（含向用户澄清开放问题）
        const prd = await this.runRequirementAnalysis(project, dir, pool)
        const kickoff = await rt.meetingRunner.runKickoff(project, prd ?? undefined)
        tasks = kickoff.tasks
        if (tasks.length === 0) {
          throw new Error('kickoff 会议没有产出任何任务，请检查需求描述后重开项目')
        }
        // 4. 架构师写设计文档
        await this.writeDesignDoc(project, dir, kickoff.summary, pool)
      }

      // 5. 预算守卫 + 任务流转
      if (!(await this.checkBudget(getProject(projectId)!))) return
      rt.flow = new TaskFlow(pool, this.gate, projectId, dir, () => this.checkBudget(getProject(projectId)!))
      const { done, blocked } = await rt.flow.runAll()

      // 6. 收尾
      if (done) {
        await this.finishProject(project, pool)
      } else if (blocked.length > 0) {
        await this.pauseProject(projectId)
        const blockedLines = blocked.map((b) => `#${b.id} ${b.title}: ${b.review_notes ?? b.status}`).join('\n')
        postMessage(null, 'system', tx().blockedPauseMsg(blockedLines), undefined, null, projectId)
        await this.reporter.generate('manual', projectId).catch(() => {})
        this.notify(tx().notifyPausedTitle, tx().notifyPausedMsg(blocked.length))
      }
    } catch (err) {
      const e = err as Error
      setProjectStatus(projectId, 'failed')
      broadcast('project', getProject(projectId))
      logEvent('project.failed', null, { id: projectId, error: e.message.slice(0, 500) })
      this.notify(tx().notifyFailedTitle, e.message.slice(0, 100))
    } finally {
      rt.flowActive = false
    }
  }

  /**
   * BA 需求分析阶段：产出 PRD、开放问题升级用户澄清、修订、落盘 repo/PRD.md 并提交。
   * BA 未启用或 PRD 已存在（重启续跑）时返回已有内容/null。
   */
  private async runRequirementAnalysis(project: ProjectRow, dir: string, pool: AgentPool): Promise<string | null> {
    const repoDir = path.join(dir, 'repo')
    const prdPath = path.join(repoDir, 'PRD.md')
    if (existsSync(prdPath)) return readFileSync(prdPath, 'utf-8')
    if (!roleEnabled('ba')) return null
    const t = tx()

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

  private async writeDesignDoc(project: ProjectRow, dir: string, meetingSummary: string, pool: AgentPool): Promise<void> {
    const repoDir = path.join(dir, 'repo')
    const designPath = path.join(repoDir, 'DESIGN.md')
    await pool.ask('architect', tx().designDoc(designPath, meetingSummary), {
      statusDetail: tx().stDesigning,
      timeoutMs: 15 * 60_000,
    })

    // 架构设计环：质疑者审 → 架构师修订 → 复审，循环到放行或上限
    await this.challengeDesign(project, repoDir, pool)

    // 设计文档入库（main 分支），之后创建的任务 worktree 都能看到
    await git(['add', '-A'], repoDir)
    await git(['commit', '-m', 'docs: 架构设计文档 (DESIGN.md)', '--allow-empty'], repoDir)
    logEvent('design.committed', 'architect', {})
  }

  /** 架构设计环：提案 → 质疑 → 修订 → 再质疑，循环到质疑者放行或 design_max_cycles 兜底 */
  private async challengeDesign(project: ProjectRow, repoDir: string, pool: AgentPool): Promise<void> {
    if (getSetting('challenge_design') !== 'on' || !roleEnabled('challenger')) return
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

  private async finishProject(project: ProjectRow, pool: AgentPool): Promise<void> {
    const t = tx()
    setProjectStatus(project.id, 'done')
    broadcast('project', getProject(project.id))
    logEvent('project.done', null, { id: project.id })
    const closing = await pool
      .ask('coordinator', t.delivery(), { statusDetail: t.stDelivery, timeoutMs: 5 * 60_000 })
      .catch(() => '')
    if (closing) postMessage(null, 'coordinator', t.deliveryMsg(closing), undefined, null, project.id)
    await distillProject(pool, project).catch(() => {})
    await this.reporter.generate('manual', project.id).catch(() => {})
    this.notify(t.notifyDoneTitle, t.notifyDoneMsg(project.name))
    // 项目结束统一回收会话（project_end 档）：进行期间保热、结束才释放（只回收本项目的池）
    if (getSetting('session_recycle') === 'project_end') pool.recycleAllIdle()
  }

  /** 预算守卫：超预算时请用户追加或暂停。按 project_id 精确归账（迁移前的 NULL 旧行属历史项目，按策略不计入） */
  async checkBudget(project: ProjectRow): Promise<boolean> {
    const cost = usageSummary(undefined, project.id).cost_usd
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
    // 每项目独立池：协作工具已绑定本项目，非活动项目的修改要求也会正确落到它自己身上
    //（旧版"非活动项目只能问不能改"的限制随 create_task 的 activeProject() 绑定一起拆除）
    const rt = this.runtime(project.id)
    // 服务重启后 runtime 池是空的 → 懒启动协调者会话。
    // 不 resume：对话所需上下文全靠下方 prompt 注入（项目快照+任务档案），
    // 且旧 session_id 在重启后往往已失效（No conversation found），新建会话最稳。
    if (!rt.pool.has('coordinator')) {
      void ensureLocalProxy() // 协调者模型也可能走本机代理；异步拉起不阻塞对话（未就绪时该轮失败，下轮即好）
      rt.pool.startAgents(projectDir(project.id), project.id, ['coordinator'])
    }
    const tasks = listTasks(project.id)
    const cost = usageSummary(undefined, project.id).cost_usd
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
    const reply = await rt.pool
      .ask('coordinator', t.userChat(ctx, message, taskDetail), { statusDetail: t.stChat, timeoutMs: 4 * 60_000 })
      .catch((e) => t.chatUnavailable((e as Error).message.slice(0, 120)))
    postMessage(null, 'coordinator', reply, 'user', taskId, project.id)
    logEvent('chat.replied', 'coordinator', { project: project.id, task: taskId ?? null, preview: reply.slice(0, 80) })
    // 若这轮新建了可执行任务、而项目当前不在运行 → 拉起调度让它落地（任何项目都行，不再限活动项目）
    if (project.status !== 'running') {
      const runnable = listTasks(project.id).some((k) => ['assigned', 'in_progress', 'review', 'qa', 'challenge', 'final'].includes(k.status))
      if (runnable) void this.resumeProject(project.id)
    }
    return reply
  }

  /** 把项目设为活动（视图/对话的默认目标）：多项目并发下只移动指针，不再隐式拉起运行——恢复是显式动作 */
  async activateProject(id: number): Promise<void> {
    setActiveProject(id)
    broadcast('project', getProject(id))
    logEvent('project.activated', null, { id })
  }

  // ---------------- 外部回调 ----------------

  onApprovalDecided(approval: ApprovalRow): void {
    this.gate.resolve(approval)
  }

  async generateReportNow(): Promise<unknown | null> {
    return this.reporter.generate('manual', activeProject()?.id)
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
    for (const rt of this.runtimes.values()) rt.flow?.stop()
    stopLocalProxy()
    await Promise.allSettled([...this.runtimes.values()].map((rt) => rt.pool.closeAll()))
  }
}

export const engine = new Engine()
