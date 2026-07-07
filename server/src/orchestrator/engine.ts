import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import notifier from 'node-notifier'
import type { AgentId, ApprovalRow, MessageRow, ProjectRow } from '../types'
import { ROOT_DIR, WORKSPACES_DIR } from '../db/index'
import {
  addMessage,
  currentProject,
  getProject,
  listAgents,
  listTasks,
  setProjectStatus,
  updateProjectBudget,
  usageSummary,
} from '../db/dao'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { git, initProjectRepo } from '../lib/git'
import { getSetting } from '../settings'
import { AgentPool } from './agentPool'
import { ApprovalGate } from './approvalGate'
import { MeetingRunner, parseJsonBlock } from './meetingRunner'
import { TaskFlow } from './taskFlow'
import { Reporter } from './reporter'
import { teamLang, tx } from './texts'

const PROMPTS_DIR = path.join(ROOT_DIR, 'server', 'prompts')
const ALL_AGENTS: AgentId[] = ['coordinator', 'architect', 'frontend', 'backend', 'reviewer', 'qa', 'challenger']

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

/** 发一条消息并广播，返回记录 */
export function postMessage(meetingId: number | null, from: string, content: string, to?: string): MessageRow {
  const row = addMessage({ meeting_id: meetingId, from_agent: from, to_agent: to ?? null, content })
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
      if (getSetting('challenge_approvals') !== 'on') return null
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

      // 2. 启动全员会话（重启后自动带 resume 恢复上下文；新项目先关掉旧项目的会话）
      const pool = this.getPool()
      if (mode === 'start') await pool.closeAll()
      const resumeIds = new Map(listAgents().filter((a) => a.session_id).map((a) => [a.id, a.session_id!] as const))
      pool.startAgents(dir, ALL_AGENTS, mode === 'resume' ? resumeIds : undefined)

      // 3. kickoff（已有任务说明开过会了，跳过）
      let tasks = listTasks(projectId)
      if (tasks.length === 0) {
        const kickoff = await this.getMeetingRunner().runKickoff(project)
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

  private async writeDesignDoc(project: ProjectRow, dir: string, meetingSummary: string): Promise<void> {
    const repoDir = path.join(dir, 'repo')
    const designPath = path.join(repoDir, 'DESIGN.md')
    await this.getPool().ask('architect', tx().designDoc(designPath, meetingSummary), {
      statusDetail: tx().stDesigning,
      timeoutMs: 15 * 60_000,
    })

    // 质疑者审设计 → 架构师修订一轮
    await this.challengeDesign(repoDir)

    // 设计文档入库（main 分支），之后创建的任务 worktree 都能看到
    await git(['add', '-A'], repoDir)
    await git(['commit', '-m', 'docs: 架构设计文档 (DESIGN.md)', '--allow-empty'], repoDir)
    logEvent('design.committed', 'architect', {})
  }

  private async challengeDesign(repoDir: string): Promise<void> {
    if (getSetting('challenge_design') !== 'on') return
    const pool = this.getPool()
    if (!pool.has('challenger')) return
    const t = tx()
    const designPath = path.join(repoDir, 'DESIGN.md')
    const critique = await pool
      .ask('challenger', t.designChallenge(designPath), { statusDetail: t.stChallengingDesign, timeoutMs: 10 * 60_000 })
      .catch(() => null)
    if (!critique) return
    const verdict = parseJsonBlock<{ pass?: boolean; issues?: Array<{ concern: string; suggestion?: string }> }>(critique)
    const issues = verdict?.issues ?? []
    if (!verdict || verdict.pass !== false || issues.length === 0) {
      logEvent('challenge.design_pass', 'challenger', {})
      return
    }
    const issuesText = issues.map((i) => `- ${i.concern}${i.suggestion ? ` → ${i.suggestion}` : ''}`).join('\n')
    postMessage(null, 'challenger', t.designIssuesMsg(issuesText), 'architect')
    logEvent('challenge.design', 'challenger', { issues: issues.length })
    const revision = await pool.ask('architect', t.designRevision(issuesText, designPath), {
      statusDetail: t.stRevisingDesign,
      timeoutMs: 15 * 60_000,
    })
    postMessage(null, 'architect', t.designRevisionMsg(revision), 'challenger')
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
    await this.reporter.generate('manual').catch(() => {})
    this.notify(t.notifyDoneTitle, t.notifyDoneMsg(project.name))
  }

  /** 预算守卫：超预算时请用户追加或暂停 */
  async checkBudget(project: ProjectRow): Promise<boolean> {
    const cost = usageSummary().cost_usd
    if (cost < project.budget_usd) return true
    const t = tx()
    const decided = await this.gate.request({
      project_id: project.id,
      requested_by: 'coordinator',
      title: t.budgetTitle(cost, project.budget_usd),
      context: t.budgetContext,
      options: [t.budgetAdd5, t.budgetAdd20, t.budgetPause],
      recommendation: t.budgetAdd5,
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
