import { getProject, getTask, listTasks, setProjectStatus, setTaskStatus, updateTask, addMessage } from '../db/dao'
import type { AgentId, TaskRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { budgetOnlyApprovals, getSetting, getSettingNumber, roleEnabled } from '../settings'
import { archiveLesson, distillTask, lessonsForBrief } from './memory'
import { branchHasCommits, createTaskWorktree, mergeTaskBranch, taskDiff } from '../lib/git'
import type { AgentPool } from './agentPool'
import type { ApprovalGate } from './approvalGate'
import { parseJsonBlock } from './meetingRunner'
import { tx } from './texts'
import { isQuotaError } from '../providers'

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
    // 服务重启/中断会把正在开发的任务留在 in_progress（该状态只在 dev 回合在飞时合法，
    // 而新 TaskFlow 里没有任何在飞回合）——不归位它们会成为调度不到的僵尸，最终误判"无法推进"暂停项目
    for (const t of listTasks(this.projectId)) {
      if (t.status === 'in_progress') {
        const fixed = setTaskStatus(t.id, 'assigned')
        broadcast('task', fixed)
        logEvent('task.orphan_normalized', null, { id: t.id, from: 'in_progress' })
      }
    }
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

  /** 各质检阶段的下一站（对应角色被关闭时跳过；'merge' 表示直接合并收尾） */
  private nextAfterDev(): TaskRow['status'] | 'merge' {
    return roleEnabled('reviewer') ? 'review' : this.nextAfterReview()
  }
  private nextAfterReview(): TaskRow['status'] | 'merge' {
    return roleEnabled('qa') ? 'qa' : this.nextAfterQa()
  }
  private nextAfterQa(): TaskRow['status'] | 'merge' {
    return roleEnabled('challenger') && getSetting('challenge_tasks') === 'on' ? 'challenge' : 'merge'
  }

  /** 阶段通过后的推进（统一处理 merge 直达） */
  private async advance(taskId: number, next: TaskRow['status'] | 'merge'): Promise<void> {
    if (next === 'merge') {
      await this.mergeAndFinish(taskId)
      return
    }
    const t = setTaskStatus(taskId, next)
    broadcast('task', t)
  }

  /** 找到当前可推进的任务并启动处理（每个 agent 同时只处理一件事） */
  private launchRunnable(tasks: TaskRow[]): boolean {
    let launched = false
    // 用户点名的优先任务（对话中的修改要求）插队调度
    const ordered = [...tasks].sort((a, b) => b.priority - a.priority || a.id - b.id)
    for (const task of ordered) {
      if (this.inFlight.has(task.id)) continue
      // 角色被关闭后仍停留在该阶段的任务（如运行中改设置）→ 直接推进
      if (
        (task.status === 'review' && !roleEnabled('reviewer')) ||
        (task.status === 'qa' && !roleEnabled('qa')) ||
        (task.status === 'challenge' && !(roleEnabled('challenger') && getSetting('challenge_tasks') === 'on'))
      ) {
        this.inFlight.add(task.id)
        const next = task.status === 'review' ? this.nextAfterReview() : task.status === 'qa' ? this.nextAfterQa() : 'merge'
        void this.advance(task.id, next).finally(() => this.inFlight.delete(task.id))
        launched = true
        continue
      }
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
        // 配额/限流/欠费类错误不是任务本身的问题：任务退回原阶段，整个项目暂停等待恢复
        if (isQuotaError(e.message)) {
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
    const freshSession = !this.pool.isLive(assignee)
    const prompt =
      t9.devBrief({
        id: task.id,
        title: task.title,
        desc: task.description ?? '',
        worktree,
        branch,
        reworkNote: rework ? task.review_notes : null,
      }) +
      lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 5) +
      (freshSession ? `\n${t9.memoryRebuildNote}` : '')

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
    logEvent('task.dev_done', assignee, { id: task.id })
    await this.advance(task.id, this.nextAfterDev())
  }

  // ---------- 审查阶段 ----------
  private async reviewPhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'review')
    if (!task) return
    const diff = await taskDiff(this.projectDir, task.branch!)
    const reply = await this.pool.ask(
      'reviewer',
      t9.reviewBrief({ id: task.id, title: task.title, desc: task.description ?? '', branch: task.branch!, worktree: task.worktree ?? '', diff }) +
        lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 3),
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
      await this.advance(task.id, this.nextAfterReview())
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
      t9.qaBrief({ id: task.id, title: task.title, desc: task.description ?? '', worktree: task.worktree ?? '', branch: task.branch! }) +
        lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 3),
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

    // QA 通过 → 质疑者挑刺（角色启用且开关开），否则直接合并
    await this.advance(task.id, this.nextAfterQa())
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
    // 非拦截意见也归档进团队记忆（零成本 raw 记录）
    if (concernsText) {
      archiveLesson({ project_id: this.projectId, source_type: 'task', source_id: task.id, tags: task.title, content: concernsText, created_by: 'challenger' })
    }

    if (verdict?.blocking) {
      await this.handleRework(task, t9.challengeReworkNote(verdict.summary ?? '', concernsText))
      return
    }
    await this.mergeAndFinish(task.id)
  }

  // ---------- 合并收尾 ----------
  private async mergeAndFinish(taskId: number): Promise<void> {
    const t9 = tx()
    const task = getTask(taskId)!
    try {
      await mergeTaskBranch(this.projectDir, task.id)
      const t = setTaskStatus(task.id, 'done')
      broadcast('task', t)
      logEvent('task.done', null, { id: task.id, title: task.title })
      this.onTaskFinished(getTask(taskId)!)
    } catch (err) {
      const e = err as Error
      logEvent('task.merge_conflict', null, { id: task.id, error: e.message.slice(0, 200) })
      // 并行任务合并冲突很常见：首次冲突自动打回返工（带 merge main 指引）；连续冲突才阻塞升级用户
      const autoNote = t9.mergeAutoReworkNote(task.id)
      const alreadyTriedOnce = task.review_notes?.slice(0, 30) === autoNote.slice(0, 30)
      if (!alreadyTriedOnce) {
        const t = updateTask(task.id, { status: 'assigned', review_cycles: Math.max(1, task.review_cycles), review_notes: autoNote })
        broadcast('task', t)
        logEvent('task.merge_auto_rework', null, { id: task.id })
        return
      }
      const t = setTaskStatus(task.id, 'blocked', t9.mergeConflictNote(e.message.slice(0, 300)))
      broadcast('task', t)
    }
  }

  /** 任务终结钩子：返工过的提炼教训 + 回收相关会话（省 token） */
  private onTaskFinished(task: TaskRow): void {
    if (task.review_cycles > 0) distillTask(this.pool, task)
    if (getSetting('session_recycle') === 'on') {
      const involved: AgentId[] = [...new Set([task.assignee, 'reviewer', 'qa', 'challenger'].filter(Boolean))] as AgentId[]
      for (const id of involved) {
        if (!this.busy.has(id)) this.pool.recycleIfIdle(id)
      }
    }
  }

  // ---------- 打回处理：超过上限升级用户 ----------
  private async handleRework(task: TaskRow, note: string): Promise<void> {
    const t9 = tx()
    // 返工意见自动归档进团队记忆（raw，供书记官日后提炼）
    archiveLesson({ project_id: this.projectId, source_type: 'task', source_id: task.id, tags: task.title, content: note, created_by: 'system' })
    const cycles = task.review_cycles + 1
    const maxCycles = Math.max(1, getSettingNumber('max_review_cycles'))
    if (cycles >= maxCycles) {
      // 仅预算审批策略：不升级用户——恰好到上限时自动多给一轮（不清零计数），再失败就阻塞。
      // 不能走通用自动批准（推荐项"再给一轮"会清零计数 → 无限返工烧钱）
      if (budgetOnlyApprovals()) {
        if (cycles === maxCycles) {
          const t = updateTask(task.id, { status: 'assigned', review_cycles: cycles, review_notes: note })
          broadcast('task', t)
          logEvent('task.auto_extra_round', null, { id: task.id, cycles })
          const msg = addMessage({ meeting_id: null, from_agent: 'system', content: t9.autoExtraRoundMsg(task.id, task.title, cycles) })
          broadcast('message', msg)
          return
        }
        const t = setTaskStatus(task.id, 'blocked', t9.abandonedNote(t9.autoApprovedNote))
        broadcast('task', t)
        this.onTaskFinished(getTask(task.id)!)
        return
      }
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
        this.onTaskFinished(getTask(task.id)!)
        return
      }
      if (choice === t9.reworkOptAbandon) {
        const t = setTaskStatus(task.id, 'blocked', t9.abandonedNote(decided.comment ?? undefined))
        broadcast('task', t)
        this.onTaskFinished(getTask(task.id)!)
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
