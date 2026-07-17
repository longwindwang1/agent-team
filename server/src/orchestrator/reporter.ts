import cron, { type ScheduledTask } from 'node-cron'
import notifier from 'node-notifier'
import {
  addReport,
  getProject,
  lastReportStats,
  lastReportTime,
  listProjects,
  listTasks,
  pendingApprovals,
  usageSummary,
} from '../db/dao'
import type { ProjectRow } from '../types'

/** 报告统计与上次（本项目的）报告相比是否有变化（成本字段忽略微小波动） */
export function statsChangedSinceLastReport(stats: Record<string, unknown>, projectId?: number): boolean {
  const prev = lastReportStats(projectId)
  if (!prev) return true
  const normalize = (s: Record<string, unknown>) =>
    JSON.stringify({ ...s, cost_usd_total: undefined, cost_usd_period: undefined, project: { ...(s.project as object), status: undefined } })
  const tasksChanged = normalize(stats) !== normalize(prev)
  const statusChanged = (stats.project as { status?: string })?.status !== (prev.project as { status?: string })?.status
  return tasksChanged || statusChanged
}
import type { ReportRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { getSetting } from '../settings'
import type { AgentPool } from './agentPool'
import { tx } from './texts'

/** 定时进度汇报：默认每 2 小时；测试模式每 2 分钟。多项目并发：定时路径逐个汇报所有进行中项目 */
export class Reporter {
  private job: ScheduledTask | null = null

  constructor(private readonly poolFor: (projectId: number) => AgentPool | null) {}

  schedule(): void {
    this.job?.stop()
    this.job = null
    const expr = getSetting('report_test_mode') === 'fast' ? '*/2 * * * *' : getSetting('report_cron')
    if (!cron.validate(expr)) {
      logEvent('reporter.invalid_cron', null, { expr })
      return
    }
    this.job = cron.schedule(expr, () => {
      void this.generate('scheduled').catch((err) => {
        logEvent('reporter.error', null, { error: (err as Error).message.slice(0, 300) })
      })
    })
    logEvent('reporter.scheduled', null, { expr })
  }

  /** 生成报告：指定 projectId 报该项目（手动触发路径，done 项目也报）；
   *  缺省则逐个报所有 running/paused 项目（定时路径，多项目并发下一个不落） */
  async generate(trigger: 'scheduled' | 'manual', projectId?: number): Promise<ReportRow | null> {
    if (projectId != null) {
      const project = getProject(projectId)
      return project ? this.generateFor(project, trigger) : null
    }
    let last: ReportRow | null = null
    for (const project of listProjects()) {
      if (project.status !== 'running' && project.status !== 'paused') continue
      try {
        last = (await this.generateFor(project, trigger)) ?? last
      } catch (err) {
        logEvent('reporter.error', null, { project: project.id, error: (err as Error).message.slice(0, 300) })
      }
    }
    return last
  }

  private async generateFor(project: ProjectRow, trigger: 'scheduled' | 'manual'): Promise<ReportRow | null> {
    const since = lastReportTime(project.id)
    const tasks = listTasks(project.id)
    const byStatus = (s: string) => tasks.filter((t) => t.status === s)
    const pending = pendingApprovals().filter((a) => a.project_id === project.id || a.project_id == null)
    const usage = usageSummary(undefined, project.id)
    const usageSince = since ? usageSummary(since, project.id) : usage

    const stats = {
      project: { id: project.id, name: project.name, status: project.status },
      tasks: {
        total: tasks.length,
        done: byStatus('done').length,
        in_progress: byStatus('in_progress').length,
        review: byStatus('review').length,
        qa: byStatus('qa').length,
        final: byStatus('final').length,
        assigned: byStatus('assigned').length,
        blocked: byStatus('blocked').length,
      },
      pending_approvals: pending.length,
      cost_usd_total: usage.cost_usd,
      cost_usd_period: usageSince.cost_usd,
    }

    // 定时报告：与本项目上次报告相比毫无变化则跳过（避免深夜空转烧钱）
    if (trigger === 'scheduled' && !statsChangedSinceLastReport(stats, project.id)) {
      logEvent('report.skipped_no_change', null, { project: project.id })
      return null
    }

    const t9 = tx()
    const taskLines = tasks
      .map((t) => `- #${t.id} [${t.status}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}${t.review_notes ? ` | ${t.review_notes.slice(0, 100)}` : ''}`)
      .join('\n')
    const approvalLines = pending.map((a) => `- #${a.id} ${a.title} (${a.requested_by})`).join('\n')

    let markdown: string | null = null
    const pool = this.poolFor(project.id)
    if (pool && pool.has('coordinator')) {
      // 让协调者写报告（有上下文、语言更自然）；失败（如配额耗尽）降级为系统生成
      markdown = await pool.ask(
        'coordinator',
        t9.reportInstruction({
          since: since ?? undefined,
          projectName: project.name,
          status: project.status,
          taskStats: t9.taskStatsLine({
            done: stats.tasks.done,
            total: stats.tasks.total,
            inprog: stats.tasks.in_progress,
            review: stats.tasks.review,
            qa: stats.tasks.qa,
            challenge: tasks.filter((t) => t.status === 'challenge').length,
            final: stats.tasks.final,
            assigned: stats.tasks.assigned,
            blocked: stats.tasks.blocked,
          }),
          taskLines,
          approvalLines,
          costPeriod: stats.cost_usd_period.toFixed(2),
          costTotal: stats.cost_usd_total.toFixed(2),
          budget: String(project.budget_usd),
        }),
        { statusDetail: t9.stReport, timeoutMs: 5 * 60_000 },
      ).catch(() => null)
    }
    if (markdown == null) {
      // agent 不在线或调用失败（如配额耗尽）时降级为系统生成
      markdown = t9.reportFallback({
        done: byStatus('done').map((t) => `- #${t.id} ${t.title}`).join('\n'),
        doing: tasks.filter((t) => ['in_progress', 'review', 'qa', 'challenge', 'final', 'assigned'].includes(t.status)).map((t) => `- #${t.id} [${t.status}] ${t.title}`).join('\n'),
        blocked: [...byStatus('blocked').map((t) => `- #${t.id} ${t.title}: ${t.review_notes ?? ''}`), ...pending.map((a) => `- ${a.title}`)].join('\n'),
        costPeriod: stats.cost_usd_period.toFixed(2),
        costTotal: stats.cost_usd_total.toFixed(2),
        budget: String(project.budget_usd),
      })
    }

    const row = addReport({
      project_id: project.id,
      period_start: since ?? project.created_at,
      period_end: new Date().toISOString(),
      markdown,
      stats,
    })
    broadcast('report', row)
    logEvent('report.generated', 'coordinator', { id: row.id, trigger })

    try {
      notifier.notify({
        title: t9.toastReportTitle(row.id),
        message: t9.toastReportMsg(project.name, stats.tasks.done, stats.tasks.total, pending.length),
        appID: 'Agent Team',
      })
    } catch {
      // 通知失败不影响主流程
    }
    return row
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }
}
