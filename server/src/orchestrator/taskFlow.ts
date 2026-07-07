import { getProject, getTask, listTasks, setProjectStatus, setTaskStatus, updateTask, addMessage } from '../db/dao'
import type { AgentId, TaskRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { getSetting, getSettingNumber } from '../settings'
import { branchHasCommits, createTaskWorktree, mergeTaskBranch, taskDiff } from '../lib/git'
import type { AgentPool } from './agentPool'
import type { ApprovalGate } from './approvalGate'
import { parseJsonBlock } from './meetingRunner'
import { tx } from './texts'

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

interface ReviewVerdict {
  approve: boolean
  summary?: string
  findings?: Array<{ severity: string; file?: string; issue: string; suggestion?: string }>
}

interface QaVerdict {
  pass: boolean
  summary?: string
  verified?: string[]
  issues?: Array<{ severity: string; case: string; expected?: string; actual?: string }>
}

/**
 * 任务流转引擎：assigned → in_progress → review → qa → done
 * 不同 agent 的工作并行，单个 agent 串行（AgentSession.ask 内部已串行化）。
 */
export class TaskFlow {
  private busy = new Set<AgentId>()
  private inFlight = new Set<number>()
  private stopped = false

  constructor(
    private readonly pool: AgentPool,
    private readonly gate: ApprovalGate,
    private readonly projectId: number,
    private readonly projectDir: string,
    /** 预算守卫：返回 false 表示暂停（引擎负责改项目状态） */
    private readonly checkBudget?: () => Promise<boolean>,
  ) {}

  stop(): void {
    this.stopped = true
  }

  /** 主调度循环：直到所有任务 done，或没有可推进的任务为止 */
  async runAll(): Promise<{ done: boolean; blocked: TaskRow[] }> {
    while (!this.stopped) {
      const project = getProject(this.projectId)
      if (!project || project.status === 'failed') break
      if (project.status === 'paused') {
        await sleep(3000)
        continue
      }

      // 预算守卫先行：这里可能长时间阻塞等审批，任务快照必须在它之后读取（否则会用过期状态重复调度）
      if (this.checkBudget && !(await this.checkBudget())) continue

      const tasks = listTasks(this.projectId)
      if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) {
        return { done: true, blocked: [] }
      }

      const launched = this.launchRunnable(tasks)
      if (!launched && this.inFlight.size === 0) {
        const blocked = tasks.filter((t) => t.status !== 'done')
        return { done: blocked.length === 0, blocked }
      }
      await sleep(1500)
    }
    return { done: false, blocked: [] }
  }

  /** 找到当前可推进的任务并启动处理（每个 agent 同时只处理一件事） */
  private launchRunnable(tasks: TaskRow[]): boolean {
    let launched = false
    for (const task of tasks) {
      if (this.inFlight.has(task.id)) continue
      if (task.status === 'assigned' && task.assignee && !this.busy.has(task.assignee)) {
        this.launch(task.id, task.assignee, () => this.devPhase(task.id))
        launched = true
      } else if (task.status === 'review' && !this.busy.has('reviewer')) {
        this.launch(task.id, 'reviewer', () => this.reviewPhase(task.id))
        launched = true
      } else if (task.status === 'qa' && !this.busy.has('qa')) {
        this.launch(task.id, 'qa', () => this.qaPhase(task.id))
        launched = true
      } else if (task.status === 'challenge' && !this.busy.has('challenger')) {
        this.launch(task.id, 'challenger', () => this.challengePhase(task.id))
        launched = true
      }
    }
    return launched
  }

  private launch(taskId: number, agent: AgentId, fn: () => Promise<void>): void {
    this.busy.add(agent)
    this.inFlight.add(taskId)
    void fn()
      .catch((err) => {
        const e = err as Error
        // 配额/限流类错误不是任务本身的问题：任务退回原阶段，整个项目暂停等待恢复
        if (/session limit|rate limit|overloaded|quota/i.test(e.message)) {
          const task = getTask(taskId)
          if (task && task.status === 'in_progress') {
            const t = setTaskStatus(taskId, 'assigned')
            broadcast('task', t)
          }
          setProjectStatus(this.projectId, 'paused')
          broadcast('project', getProject(this.projectId))
          logEvent('quota.exhausted', agent, { id: taskId, error: e.message.slice(0, 200) })
          return
        }
        const t = setTaskStatus(taskId, 'blocked', tx().taskErrorNote(e.message.slice(0, 300)))
        broadcast('task', t)
        logEvent('task.error', agent, { id: taskId, error: e.message.slice(0, 300) })
      })
      .finally(() => {
        this.busy.delete(agent)
        this.inFlight.delete(taskId)
      })
  }

  /** 阶段开工前校验任务仍处于预期状态（防止基于过期快照的重复调度） */
  private stillIn(taskId: number, status: TaskRow['status']): TaskRow | null {
    const task = getTask(taskId)
    return task && task.status === status ? task : null
  }

  // ---------- 开发阶段 ----------
  private async devPhase(taskId: number): Promise<void> {
    const task = this.stillIn(taskId, 'assigned')
    if (!task) return
    const assignee = task.assignee as AgentId
    const { worktree, branch } = await createTaskWorktree(this.projectDir, task.id)
    const t1 = updateTask(task.id, { status: 'in_progress', worktree, branch })
    broadcast('task', t1)
    logEvent('task.dev_started', assignee, { id: task.id, worktree })

    const t9 = tx()
    const rework = task.review_cycles > 0 && task.review_notes
    const prompt = t9.devBrief({
      id: task.id,
      title: task.title,
      desc: task.description ?? '',
      worktree,
      branch,
      reworkNote: rework ? task.review_notes : null,
    })

    const summary = await this.pool.ask(assignee, prompt, {
      statusDetail: t9.stDev(task.id),
      timeoutMs: 30 * 60_000,
    })

    const hasCommits = await branchHasCommits(this.projectDir, branch).catch(() => false)
    if (!hasCommits) {
      const t = setTaskStatus(task.id, 'blocked', t9.noCommitsNote(summary.slice(0, 300)))
      broadcast('task', t)
      logEvent('task.no_commits', assignee, { id: task.id })
      return
    }

    const msg = addMessage({ meeting_id: null, from_agent: assignee, to_agent: 'reviewer', content: t9.devDoneDm(task.id, summary) })
    broadcast('message', msg)
    const t2 = setTaskStatus(task.id, 'review')
    broadcast('task', t2)
    logEvent('task.dev_done', assignee, { id: task.id })
  }

  // ---------- 审查阶段 ----------
  private async reviewPhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'review')
    if (!task) return
    const diff = await taskDiff(this.projectDir, task.branch!)
    const reply = await this.pool.ask(
      'reviewer',
      t9.reviewBrief({ id: task.id, title: task.title, desc: task.description ?? '', branch: task.branch!, worktree: task.worktree ?? '', diff }),
      { statusDetail: t9.stReview(task.id), timeoutMs: 15 * 60_000 },
    )

    const verdict = parseJsonBlock<ReviewVerdict>(reply)
    const findingsText = (verdict?.findings ?? [])
      .map((f) => `[${f.severity}] ${f.file ?? ''} ${f.issue}${f.suggestion ? ` → ${f.suggestion}` : ''}`)
      .join('\n')

    const msg = addMessage({
      meeting_id: null,
      from_agent: 'reviewer',
      to_agent: task.assignee,
      content: t9.reviewResultDm(task.id, verdict?.approve ?? false, verdict?.summary ?? '', findingsText),
    })
    broadcast('message', msg)
    logEvent('task.reviewed', 'reviewer', { id: task.id, approve: verdict?.approve ?? false })

    if (verdict?.approve) {
      const t = setTaskStatus(task.id, 'qa')
      broadcast('task', t)
      return
    }
    await this.handleRework(task, t9.reviewReworkNote(verdict?.summary ?? reply.slice(0, 300), findingsText))
  }

  // ---------- QA 阶段 ----------
  private async qaPhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'qa')
    if (!task) return
    const reply = await this.pool.ask(
      'qa',
      t9.qaBrief({ id: task.id, title: task.title, desc: task.description ?? '', worktree: task.worktree ?? '', branch: task.branch! }),
      { statusDetail: t9.stQa(task.id), timeoutMs: 20 * 60_000 },
    )

    const verdict = parseJsonBlock<QaVerdict>(reply)
    const issuesText = (verdict?.issues ?? [])
      .map((i) => `[${i.severity}] ${i.case}: ${i.expected ?? '-'} ≠ ${i.actual ?? '-'}`)
      .join('\n')

    const msg = addMessage({
      meeting_id: null,
      from_agent: 'qa',
      to_agent: task.assignee,
      content: t9.qaResultDm(task.id, verdict?.pass ?? false, verdict?.summary ?? '', issuesText),
    })
    broadcast('message', msg)
    logEvent('task.qa', 'qa', { id: task.id, pass: verdict?.pass ?? false })

    if (!verdict?.pass) {
      await this.handleRework(task, t9.qaReworkNote(verdict?.summary ?? reply.slice(0, 300), issuesText))
      return
    }

    // QA 通过 → 质疑者挑刺（开关开且质疑者在线），否则直接合并
    if (getSetting('challenge_tasks') === 'on' && this.pool.has('challenger')) {
      const t = setTaskStatus(task.id, 'challenge')
      broadcast('task', t)
      return
    }
    await this.mergeAndFinish(task.id)
  }

  // ---------- 质疑阶段（合并前最后一道关） ----------
  private async challengePhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'challenge')
    if (!task) return
    const diff = await taskDiff(this.projectDir, task.branch!)
    const reply = await this.pool.ask(
      'challenger',
      t9.challengeBrief({ id: task.id, title: task.title, desc: task.description ?? '', branch: task.branch!, worktree: task.worktree ?? '', diff }),
      { statusDetail: t9.stChallenge(task.id), timeoutMs: 15 * 60_000 },
    )

    const verdict = parseJsonBlock<{ blocking?: boolean; summary?: string; concerns?: Array<{ severity: string; concern: string; suggestion?: string }> }>(reply)
    const concerns = verdict?.concerns ?? []
    const concernsText = concerns.map((c) => `[${c.severity}] ${c.concern}${c.suggestion ? ` → ${c.suggestion}` : ''}`).join('\n')

    const msg = addMessage({
      meeting_id: null,
      from_agent: 'challenger',
      to_agent: task.assignee,
      content: t9.challengeResultDm(task.id, verdict?.blocking ?? false, verdict?.summary ?? '', concernsText),
    })
    broadcast('message', msg)
    logEvent('task.challenged', 'challenger', { id: task.id, blocking: verdict?.blocking ?? false, concerns: concerns.length })

    if (verdict?.blocking) {
      await this.handleRework(task, t9.challengeReworkNote(verdict.summary ?? '', concernsText))
      return
    }
    await this.mergeAndFinish(task.id)
  }

  // ---------- 合并收尾 ----------
  private async mergeAndFinish(taskId: number): Promise<void> {
    const task = getTask(taskId)!
    try {
      await mergeTaskBranch(this.projectDir, task.id)
      const t = setTaskStatus(task.id, 'done')
      broadcast('task', t)
      logEvent('task.done', null, { id: task.id, title: task.title })
    } catch (err) {
      const e = err as Error
      const t = setTaskStatus(task.id, 'blocked', tx().mergeConflictNote(e.message.slice(0, 300)))
      broadcast('task', t)
      logEvent('task.merge_conflict', null, { id: task.id, error: e.message.slice(0, 200) })
    }
  }

  // ---------- 打回处理：超过上限升级用户 ----------
  private async handleRework(task: TaskRow, note: string): Promise<void> {
    const t9 = tx()
    const cycles = task.review_cycles + 1
    const maxCycles = Math.max(1, getSettingNumber('max_review_cycles'))
    if (cycles >= maxCycles) {
      const decided = await this.gate.request({
        project_id: this.projectId,
        requested_by: 'coordinator',
        title: t9.reworkTitle(task.id, task.title, cycles),
        context: t9.reworkContext(note),
        options: [t9.reworkOptOneMore, t9.reworkOptForceMerge, t9.reworkOptAbandon],
        recommendation: t9.reworkOptOneMore,
      })
      const choice = decided.status === 'approved' ? decided.decision : t9.reworkOptAbandon
      if (choice === t9.reworkOptForceMerge) {
        await mergeTaskBranch(this.projectDir, task.id).catch(() => {})
        const t = setTaskStatus(task.id, 'done', t9.forcedPassNote)
        broadcast('task', t)
        return
      }
      if (choice === t9.reworkOptAbandon) {
        const t = setTaskStatus(task.id, 'blocked', t9.abandonedNote(decided.comment ?? undefined))
        broadcast('task', t)
        return
      }
      // 再给一轮机会 → 重置计数
      const t = updateTask(task.id, { status: 'assigned', review_cycles: 0, review_notes: t9.reworkUserNote(note, decided.comment ?? undefined) })
      broadcast('task', t)
      return
    }
    const t = updateTask(task.id, { status: 'assigned', review_cycles: cycles, review_notes: note })
    broadcast('task', t)
  }
}
