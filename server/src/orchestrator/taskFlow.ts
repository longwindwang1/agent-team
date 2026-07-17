import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getProject, getTask, listTasks, setProjectStatus, setTaskStatus, setTaskVerdict, taskVerdicts, updateTask, addMessage } from '../db/dao'
import type { AgentId, TaskRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { concurrencyFor, getSetting, getSettingNumber, roleEnabled } from '../settings'
import { archiveLesson, distillTask, lessonsForBrief } from './memory'
import { branchHasCommits, createTaskWorktree, mergeTaskBranch, taskDiff } from '../lib/git'
import { runSelfTest } from '../lib/selftest'
import type { AgentPool, AskOptions } from './agentPool'
import type { ApprovalGate } from './approvalGate'
import { parseJsonBlock } from '../lib/json'
import { normalizeFinalVerdict } from './loopControl'
import { teamLang, tx } from './texts'
import { isQuotaError } from '../providers'
import { depsSatisfied, findCycleIds, parseDeps, parseOwnsFiles } from '../lib/deps'

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
  /** 每角色进行中的任务阶段数（并发池：可同时派发到 concurrencyFor(id) 个副本会话） */
  private busy = new Map<AgentId, number>()
  private inFlight = new Set<number>()
  private stopped = false
  /** 可唤醒等待：阶段完成/外部事件时立即重跑调度，免去固定轮询的死等 */
  private wake: (() => void) | null = null
  /** 空闲兜底轮询间隔（仅为兜住审批决定/配额恢复等外部状态变化；实际推进靠 signalWake 事件驱动） */
  private static readonly IDLE_POLL_MS = 1000

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
    this.signalWake()
  }

  /** 唤醒 runAll 循环立即重跑一次调度（阶段完成、外部状态变化时调用） */
  private signalWake(): void {
    const w = this.wake
    this.wake = null
    if (w) w()
  }

  /** 可被 signalWake 提前打断的等待（否则最多等 ms 兜底） */
  private waitWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
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
        await this.waitWake(3000) // resume 时由 signalWake 立即醒
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
      // 有在飞任务时等其完成信号（阶段一结束立即醒重跑）；否则短兜底轮询
      await this.waitWake(this.inFlight.size > 0 ? 30 * 60_000 : TaskFlow.IDLE_POLL_MS)
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
    return roleEnabled('challenger') && getSetting('challenge_tasks') === 'on' ? 'challenge' : this.nextAfterChallenge()
  }
  private nextAfterChallenge(): TaskRow['status'] | 'merge' {
    // 协调者终审门：全部质检过后、合并前的完成度终判（coordinator 常驻恒可用）
    return getSetting('final_review') === 'on' ? 'final' : 'merge'
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
    // 依赖门控快照：每轮一次性建图（任务量小，O(V+E) 可忽略；同时防御 DB 手改出环）
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const cycleIds = findCycleIds(tasks)
    // 用户点名的优先任务（对话中的修改要求）插队调度
    const ordered = [...tasks].sort((a, b) => b.priority - a.priority || a.id - b.id)
    for (const task of ordered) {
      if (this.inFlight.has(task.id)) continue
      // 依赖未全部完成的任务不启动（被门控只跳过，不挡后面的任务）
      if (task.status === 'assigned' && !depsSatisfied(task, byId, cycleIds)) continue
      // 角色/开关被关闭后仍停留在该阶段的任务（如运行中改设置）→ 直接推进
      if (
        (task.status === 'review' && !roleEnabled('reviewer')) ||
        (task.status === 'qa' && !roleEnabled('qa')) ||
        (task.status === 'challenge' && !(roleEnabled('challenger') && getSetting('challenge_tasks') === 'on')) ||
        (task.status === 'final' && getSetting('final_review') !== 'on')
      ) {
        this.inFlight.add(task.id)
        const next =
          task.status === 'review'
            ? this.nextAfterReview()
            : task.status === 'qa'
              ? this.nextAfterQa()
              : task.status === 'challenge'
                ? this.nextAfterChallenge()
                : 'merge'
        void this.advance(task.id, next).finally(() => {
          this.inFlight.delete(task.id)
          this.signalWake()
        })
        launched = true
        continue
      }
      if (task.status === 'assigned' && task.assignee && this.hasCapacity(task.assignee as AgentId)) {
        this.launch(task.id, task.assignee, () => this.devPhase(task.id))
        launched = true
      } else if (task.status === 'review' && this.hasCapacity('reviewer')) {
        this.launch(task.id, 'reviewer', () => this.reviewPhase(task.id))
        launched = true
      } else if (task.status === 'qa' && this.hasCapacity('qa')) {
        this.launch(task.id, 'qa', () => this.qaPhase(task.id))
        launched = true
      } else if (task.status === 'challenge' && this.hasCapacity('challenger')) {
        this.launch(task.id, 'challenger', () => this.challengePhase(task.id))
        launched = true
      } else if (task.status === 'final' && this.hasCapacity('coordinator')) {
        this.launch(task.id, 'coordinator', () => this.finalPhase(task.id))
        launched = true
      }
    }
    return launched
  }

  private busyOf(agent: AgentId): number {
    return this.busy.get(agent) ?? 0
  }

  /** 角色还有空余并发槽位（coordinator 等未配置角色恒 1） */
  private hasCapacity(agent: AgentId): boolean {
    return this.busyOf(agent) < concurrencyFor(agent)
  }

  private launch(taskId: number, agent: AgentId, fn: () => Promise<void>): void {
    this.busy.set(agent, this.busyOf(agent) + 1)
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
        this.blockTask(taskId, tx().taskErrorNote(e.message.slice(0, 300)))
        logEvent('task.error', agent, { id: taskId, error: e.message.slice(0, 300) })
      })
      .finally(() => {
        this.busy.set(agent, Math.max(0, this.busyOf(agent) - 1))
        this.inFlight.delete(taskId)
        this.signalWake() // 阶段完成即唤醒调度，免等轮询 tick
      })
  }

  /** 阶段开工前校验任务仍处于预期状态（防止基于过期快照的重复调度） */
  private stillIn(taskId: number, status: TaskRow['status']): TaskRow | null {
    const task = getTask(taskId)
    return task && task.status === status ? task : null
  }

  /** 带一次格式重试的 JSON 裁决问询：解析失败把格式要求重发一次（弱模型/第三方端点的格式风险兜底）。
   *  经并发池取会话，且重试必须落在同一会话（jsonRetry 指涉"上一条回复"）。 */
  private async askJsonVerdict<T>(agent: AgentId, prompt: string, opts: AskOptions): Promise<{ verdict: T | null; reply: string }> {
    const session = this.pool.acquireTaskSession(agent)
    let reply = await session.ask(prompt, opts)
    let verdict = parseJsonBlock<T>(reply)
    if (verdict == null) {
      logEvent('json.retry', agent, {})
      reply = await session.ask(tx().jsonRetry(), opts)
      verdict = parseJsonBlock<T>(reply)
    }
    return { verdict, reply }
  }

  /** 统一的任务阻塞入口：落状态 + 广播 + 级联阻塞依赖它的下游（下游 note 带固定前缀，retry 时据此联动复位） */
  private blockTask(taskId: number, note: string): void {
    const t = setTaskStatus(taskId, 'blocked', note)
    broadcast('task', t)
    this.propagateBlocked(taskId)
  }

  private propagateBlocked(taskId: number): void {
    const blocked = getTask(taskId)
    if (!blocked) return
    for (const downstream of listTasks(this.projectId)) {
      if (downstream.status === 'done' || downstream.status === 'blocked') continue
      if (!parseDeps(downstream).includes(taskId)) continue
      logEvent('task.dep_blocked', null, { id: downstream.id, dep: taskId })
      this.blockTask(downstream.id, tx().depBlockedNote(taskId, blocked.title))
    }
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
    // 依赖任务的产物清单：worktree 基于最新 main 创建，门控保证前置产物已合并——直接用，别写副本
    const depsDone = parseDeps(task)
      .map((d) => getTask(d))
      .filter((d): d is TaskRow => !!d && d.status === 'done')
      .map((d) => ({ id: d.id, title: d.title, ownsFiles: parseOwnsFiles(d) }))
    const prompt =
      t9.devBrief({
        id: task.id,
        title: task.title,
        desc: task.description ?? '',
        worktree,
        branch,
        reworkNote: rework ? task.review_notes : null,
        ownsFiles: parseOwnsFiles(task),
        depsDone,
      }) +
      lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 5) +
      (freshSession ? `\n${t9.memoryRebuildNote}` : '')

    // 经并发池取会话：同角色多任务并行开发时各用独立副本（worktree 天然隔离）
    const summary = await this.pool.acquireTaskSession(assignee).ask(prompt, {
      statusDetail: t9.stDev(task.id),
      timeoutMs: 30 * 60_000,
    })

    const hasCommits = await branchHasCommits(this.projectDir, branch).catch(() => false)
    if (!hasCommits) {
      this.blockTask(task.id, t9.noCommitsNote(summary.slice(0, 300)))
      logEvent('task.no_commits', assignee, { id: task.id })
      return
    }

    // 自测门：项目声明了 test_cmd 时，系统在 worktree 里真实执行——失败不进审查、直接打回 dev 循环修
    // （省一整圈 review→QA 往返；打回计数走 handleRework，超限照常升级用户）
    if (getSetting('selftest_gate') === 'on') {
      const testCmd = getProject(this.projectId)?.test_cmd
      if (testCmd) {
        const result = await runSelfTest(worktree, testCmd)
        if (!result.ok) {
          logEvent('task.selftest_fail', assignee, { id: task.id, cmd: testCmd, timed_out: result.timedOut })
          await this.handleRework(task, t9.selftestFailNote(testCmd, result.output, result.timedOut))
          return
        }
        logEvent('task.selftest_pass', assignee, { id: task.id, cmd: testCmd })
      }
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
    const { verdict, reply } = await this.askJsonVerdict<ReviewVerdict>(
      'reviewer',
      t9.reviewBrief({ id: task.id, title: task.title, desc: task.description ?? '', branch: task.branch!, worktree: task.worktree ?? '', diff }) +
        lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 3),
      { statusDetail: t9.stReview(task.id), timeoutMs: 15 * 60_000 },
    )
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
    const { verdict, reply } = await this.askJsonVerdict<QaVerdict>(
      'qa',
      t9.qaBrief({ id: task.id, title: task.title, desc: task.description ?? '', worktree: task.worktree ?? '', branch: task.branch! }) +
        lessonsForBrief(this.projectId, `${task.title} ${task.description ?? ''}`, 3),
      { statusDetail: t9.stQa(task.id), timeoutMs: 20 * 60_000 },
    )
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

    // QA 通过 → 质疑者挑刺（角色启用且开关开）→ 终审/合并；结论摘要落库留给终审 brief（重启不丢）
    setTaskVerdict(task.id, 'qa', verdict?.summary)
    await this.advance(task.id, this.nextAfterQa())
  }

  // ---------- 质疑阶段（合并前最后一道关） ----------
  private async challengePhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'challenge')
    if (!task) return
    const diff = await taskDiff(this.projectDir, task.branch!)
    const { verdict } = await this.askJsonVerdict<{ blocking?: boolean; summary?: string; concerns?: Array<{ severity: string; concern: string; suggestion?: string }> }>(
      'challenger',
      t9.challengeBrief({ id: task.id, title: task.title, desc: task.description ?? '', branch: task.branch!, worktree: task.worktree ?? '', diff }),
      { statusDetail: t9.stChallenge(task.id), timeoutMs: 15 * 60_000 },
    )
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
    setTaskVerdict(task.id, 'challenge', verdict?.summary)
    await this.advance(task.id, this.nextAfterChallenge())
  }

  // ---------- 协调者终审（全部质检过后、合并前的完成度终判） ----------
  private async finalPhase(taskId: number): Promise<void> {
    const t9 = tx()
    const task = this.stillIn(taskId, 'final')
    if (!task) return
    // brief 刻意紧凑（diff/PRD 截断），压低协调者占用时长，避免用户对话排队过久
    const diff = await taskDiff(this.projectDir, task.branch!).catch(() => '')
    const prdPath = path.join(this.projectDir, 'repo', 'PRD.md')
    const prdExcerpt = existsSync(prdPath) ? readFileSync(prdPath, 'utf-8').slice(0, 2000) : ''
    const saved = taskVerdicts(task)
    const placeholder = teamLang() === 'zh' ? '（记录不可用）' : '(record unavailable)'
    const { verdict: raw } = await this.askJsonVerdict<{ complete?: boolean; gaps?: Array<{ gap: string; suggestion?: string }> }>(
      'coordinator',
      t9.finalBrief({
        id: task.id,
        title: task.title,
        desc: task.description ?? '',
        prdExcerpt,
        qaSummary: saved?.qa ?? placeholder,
        challengeSummary: saved?.challenge ?? placeholder,
        reworkCycles: task.review_cycles,
        diff: diff.slice(0, 4000),
      }),
      { statusDetail: t9.stFinal(task.id), timeoutMs: 10 * 60_000 },
    )
    if (raw == null) logEvent('task.final_parse_giveup', 'coordinator', { id: task.id })
    // fail-open：裁决解析失败放行合并（precedent：challengePhase 同哲学），绝不把好任务卡进返工循环
    const verdict = normalizeFinalVerdict(raw)
    const gapsText = verdict.gaps.map((g) => `- ${g.gap}${g.suggestion ? ` → ${g.suggestion}` : ''}`).join('\n')

    const msg = addMessage({
      meeting_id: null,
      from_agent: 'coordinator',
      to_agent: task.assignee,
      content: t9.finalResultDm(task.id, verdict.complete, gapsText),
    })
    broadcast('message', msg)
    logEvent('task.final', 'coordinator', { id: task.id, complete: verdict.complete, gaps: verdict.gaps.length })

    if (!verdict.complete) {
      await this.handleRework(task, t9.finalReworkNote(gapsText))
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
      // 集成回归门：合并落 main 后在 repo 跑全项目 test_cmd——"后合并任务破坏先验收任务"是实测出现过的缺口。
      // 失败不回滚合并（连锁回滚风险大），而是同任务重置回 assigned：devPhase 会基于当前 main（含坏合并）
      // 重建全新 worktree，由原开发者在其上修复回归；连续两次集成失败才阻塞升级用户（对齐合并冲突的处理哲学）
      const testCmd = getProject(this.projectId)?.test_cmd?.trim()
      if (getSetting('integration_gate') === 'on' && testCmd) {
        const result = await runSelfTest(path.join(this.projectDir, 'repo'), testCmd)
        if (!result.ok) {
          logEvent('task.integration_fail', null, { id: task.id, cmd: testCmd, timed_out: result.timedOut })
          const note = t9.integrationFailNote(testCmd, result.output, result.timedOut)
          const alreadyTriedOnce = task.review_notes?.slice(0, 20) === note.slice(0, 20)
          if (alreadyTriedOnce) {
            this.blockTask(task.id, note)
            return
          }
          const t = updateTask(task.id, { status: 'assigned', review_cycles: Math.max(1, task.review_cycles), review_notes: note })
          broadcast('task', t)
          logEvent('task.integration_rework', null, { id: task.id })
          return
        }
        logEvent('task.integration_pass', null, { id: task.id, cmd: testCmd })
      }
      const t = setTaskStatus(task.id, 'done')
      broadcast('task', t)
      logEvent('task.done', null, { id: task.id, title: task.title })
      this.onTaskFinished(getTask(taskId)!)
    } catch (err) {
      const e = err as Error
      logEvent('task.merge_conflict', null, { id: task.id, error: e.message.slice(0, 200) })
      // 并行任务合并冲突很常见：首次冲突自动打回返工（带 merge main 指引）；连续冲突才阻塞升级用户。
      // devops 启用时冲突返工改派给它（专职集成），否则原开发者自己解
      const autoNote = t9.mergeAutoReworkNote(task.id)
      const alreadyTriedOnce = task.review_notes?.slice(0, 30) === autoNote.slice(0, 30)
      if (!alreadyTriedOnce) {
        const integrator: AgentId | undefined = roleEnabled('devops') ? 'devops' : undefined
        const t = updateTask(task.id, {
          status: 'assigned',
          review_cycles: Math.max(1, task.review_cycles),
          review_notes: autoNote,
          ...(integrator ? { assignee: integrator } : {}),
        })
        broadcast('task', t)
        logEvent('task.merge_auto_rework', null, { id: task.id, reassigned_to: integrator ?? null })
        return
      }
      this.blockTask(task.id, t9.mergeConflictNote(e.message.slice(0, 300)))
    }
  }

  /** 任务终结钩子：返工过的提炼教训 + （仅 'on' 档）每任务回收会话。
   *  默认 'project_end' / 'off' 不在此回收——会话保热省冷启延迟，项目结束时由 engine 统一回收。 */
  private onTaskFinished(task: TaskRow): void {
    if (task.review_cycles > 0) distillTask(this.pool, task)
    if (getSetting('session_recycle') === 'on') {
      const involved: AgentId[] = [...new Set([task.assignee, 'reviewer', 'qa', 'challenger'].filter(Boolean))] as AgentId[]
      for (const id of involved) {
        if (this.busyOf(id) === 0) this.pool.recycleIfIdle(id)
      }
      return
    }
    // 保热策略（project_end/off）的按量兜底：上下文超阈值的会话在任务间隙回收重建，
    // 防长项目单轮成本无限上涨；0 = 关闭。含 coordinator（终审/对话让它也会涨）
    const threshold = getSettingNumber('context_recycle_tokens')
    if (threshold > 0) {
      const watched: AgentId[] = [...new Set(['coordinator', task.assignee, 'reviewer', 'qa', 'challenger'].filter(Boolean))] as AgentId[]
      for (const id of watched) {
        if (this.busyOf(id) === 0) this.pool.recycleOversized(id, threshold)
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
      // 返工超限是项目级重大判断（放弃/强制通过/再试），永远升级给用户——即使 budget_only 策略也不自动处理。
      // kind:'rework' 让审批门跳过自动批准（否则推荐项"再给一轮"会被自动选中并清零计数 → 无限返工烧钱）
      const decided = await this.gate.request({
        project_id: this.projectId,
        requested_by: 'coordinator',
        title: t9.reworkTitle(task.id, task.title, cycles),
        context: t9.reworkContext(note),
        options: [t9.reworkOptOneMore, t9.reworkOptForceMerge, t9.reworkOptAbandon],
        recommendation: t9.reworkOptOneMore,
        kind: 'rework',
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
        this.blockTask(task.id, t9.abandonedNote(decided.comment ?? undefined))
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
