import type { FastifyInstance } from 'fastify'
import {
  addLesson,
  createProject,
  currentProject,
  decideApproval,
  deleteLesson,
  getApproval,
  getTask,
  listLessons,
  setLessonPinned,
  updateTask,
  listAgents,
  listApprovals,
  listDirectMessages,
  listEvents,
  listMeetings,
  listMessages,
  listReports,
  listTasks,
  pendingApprovals,
  usageByAgent,
  usageSummary,
} from './db/dao'
import { logEvent } from './events'
import { broadcast } from './ws'
import { settingsWithDefaults, updateSettings } from './settings'
import { engine } from './orchestrator/engine'
import { archiveLesson } from './orchestrator/memory'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---- 全量状态快照（前端启动时拉取） ----
  app.get('/api/state', async () => {
    const project = currentProject() ?? null
    return {
      project,
      agents: listAgents(),
      tasks: project ? listTasks(project.id) : [],
      meetings: project ? listMeetings(project.id) : [],
      approvals: listApprovals(),
      reports: listReports(),
      usage: { total: usageSummary(), byAgent: usageByAgent() },
      events: listEvents(50),
      settings: settingsWithDefaults(),
    }
  })

  // ---- 项目 ----
  app.post<{ Body: { name: string; requirement: string; budget_usd?: number } }>('/api/projects', async (req, reply) => {
    const { name, requirement, budget_usd } = req.body ?? ({} as never)
    if (!name?.trim() || !requirement?.trim()) {
      return reply.code(400).send({ error: 'name 和 requirement 必填' })
    }
    const running = currentProject()
    if (running && (running.status === 'running' || running.status === 'paused')) {
      return reply.code(409).send({ error: '已有进行中的项目，请先等它完成' })
    }
    const project = createProject(name.trim(), requirement.trim(), budget_usd ?? 10)
    logEvent('project.created', null, { id: project.id, name: project.name })
    broadcast('project', project)
    // 异步启动编排（不阻塞响应）
    void engine.startProject(project.id)
    return project
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/pause', async (req) => {
    await engine.pauseProject(Number(req.params.id))
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/resume', async (req) => {
    await engine.resumeProject(Number(req.params.id))
    return { ok: true }
  })

  // ---- 会议 ----
  app.get('/api/meetings', async () => listMeetings())
  app.get<{ Params: { id: string } }>('/api/meetings/:id/messages', async (req) => listMessages(Number(req.params.id)))
  app.get('/api/messages/direct', async () => listDirectMessages())

  // ---- 任务 ----
  app.get('/api/tasks', async () => listTasks())

  /** 用户处理完阻塞原因（如合并冲突）后，把任务打回待开发重跑；项目若已暂停则自动继续 */
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/tasks/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    const task = getTask(id)
    if (!task) return reply.code(404).send({ error: '任务不存在' })
    if (task.status !== 'blocked') return reply.code(409).send({ error: '只有阻塞中的任务可以重试' })
    // review_cycles 至少置 1，确保开发者在返工简报里能看到 review_notes 里的处理指引
    const updated = updateTask(id, {
      status: 'assigned',
      review_cycles: Math.max(1, task.review_cycles),
      review_notes: req.body?.note ?? task.review_notes,
    })
    broadcast('task', updated)
    logEvent('task.retried', null, { id })
    const project = currentProject()
    if (project && project.status === 'paused') void engine.resumeProject(project.id)
    return updated
  })

  // ---- 审批 ----
  app.get('/api/approvals', async () => listApprovals())
  app.get('/api/approvals/pending', async () => pendingApprovals())

  app.post<{ Params: { id: string }; Body: { approve: boolean; decision?: string; comment?: string } }>(
    '/api/approvals/:id/decision',
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = getApproval(id)
      if (!existing) return reply.code(404).send({ error: '审批不存在' })
      if (existing.status !== 'pending') return reply.code(409).send({ error: '该审批已被处理' })
      const { approve, decision, comment } = req.body ?? ({} as never)
      const row = decideApproval(id, approve ? 'approved' : 'rejected', decision, comment)
      logEvent('approval.decided', null, { id, approve, decision, comment })
      broadcast('approval', row)
      // 只归档"实质决策型"审批的用户批示（带 options 的：返工/预算/选型）。
      // 跳过：BA 澄清问答（需求内容非教训）、操作型 bash 审批（rm/装依赖等运维决策，无 options）。
      if (comment?.trim() && existing.requested_by !== 'ba' && existing.options) {
        archiveLesson({
          project_id: existing.project_id,
          source_type: 'approval',
          source_id: id,
          tags: existing.requested_by,
          content: `${existing.title} → ${approve ? '✓' : '✗'} ${decision ?? ''} ${comment}`.trim(),
          created_by: 'user',
        })
      }
      engine.onApprovalDecided(row!)
      return row
    },
  )

  // ---- 报告 ----
  app.get('/api/reports', async () => listReports())
  app.post('/api/reports/generate', async () => {
    const report = await engine.generateReportNow()
    return report ?? { ok: false, error: '当前没有可汇报的项目' }
  })

  // ---- 成本 ----
  app.get('/api/usage', async () => ({ total: usageSummary(), byAgent: usageByAgent() }))

  // ---- 设置 ----
  app.get('/api/settings', async () => settingsWithDefaults())
  app.put<{ Body: Record<string, string> }>('/api/settings', async (req) => {
    updateSettings(req.body ?? {})
    engine.onSettingsChanged()
    return settingsWithDefaults()
  })

  // ---- 事件流 ----
  app.get<{ Querystring: { limit?: string } }>('/api/events', async (req) => listEvents(Number(req.query.limit ?? 100)))

  // ---- 团队记忆 ----
  app.get<{ Querystring: { q?: string } }>('/api/lessons', async (req) => listLessons({ q: req.query.q }))

  app.post<{ Body: { content: string; tags?: string; global?: boolean } }>('/api/lessons', async (req, reply) => {
    const { content, tags, global } = req.body ?? ({} as never)
    if (!content?.trim()) return reply.code(400).send({ error: 'content 必填' })
    const project = currentProject()
    const row = addLesson({
      project_id: global ? null : (project?.id ?? null),
      source_type: 'manual',
      tags,
      content: content.trim(),
      created_by: 'user',
      pinned: true, // 用户手写的坑默认置顶
    })
    logEvent('lesson.recorded', 'user', { id: row.id })
    return row
  })

  app.post<{ Params: { id: string }; Body: { pinned: boolean } }>('/api/lessons/:id/pin', async (req) => {
    setLessonPinned(Number(req.params.id), !!req.body?.pinned)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/api/lessons/:id', async (req) => {
    deleteLesson(Number(req.params.id))
    return { ok: true }
  })
}
