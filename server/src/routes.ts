import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  addLesson,
  addSkill,
  createProject,
  currentProject,
  decideApproval,
  deleteLesson,
  deleteProvider,
  deleteSkill,
  getApproval,
  getProject,
  getProvider,
  getSkill,
  getTask,
  listChatThread,
  listLessons,
  listProjects,
  listProviders,
  listSkills,
  setLessonPinned,
  updateSkill,
  updateTask,
  upsertProvider,
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
  usageByModel,
  usageSummary,
} from './db/dao'
import { git, gitArchiveStream, mergedTaskDiff, taskDiff } from './lib/git'
import { listTree, mimeFor, readWorkspaceFile, resolveSafe } from './lib/workspace'
import { logEvent } from './events'
import { broadcast } from './ws'
import { SETTING_DEFAULTS, getSetting, settingsWithDefaults, updateSettings } from './settings'
import { engine, projectDir } from './orchestrator/engine'
import { archiveLesson } from './orchestrator/memory'
import { fetchBalance, maskProvider, PROVIDER_ID_RE, PROVIDER_PRESETS, type BalanceEntry } from './providers'

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

  // ---- 用户对话（协调者即时回应；修改要求会落成优先任务/任务备注） ----
  app.post<{ Body: { message: string; task_id?: number } }>('/api/chat', async (req, reply) => {
    const message = req.body?.message?.trim()
    if (!message) return reply.code(400).send({ error: 'message 必填' })
    let taskId: number | null = null
    if (req.body?.task_id != null) {
      const task = getTask(Number(req.body.task_id))
      if (!task) return reply.code(404).send({ error: '任务不存在' })
      taskId = task.id
    }
    const answer = await engine.chatWithUser(message, taskId)
    return { reply: answer }
  })

  /** 对话线程历史：task_id 缺省 = 项目整体对话（用户 ↔ 协调者） */
  app.get<{ Querystring: { task_id?: string } }>('/api/chat/history', async (req) => {
    const taskId = req.query.task_id != null && req.query.task_id !== '' ? Number(req.query.task_id) : null
    return listChatThread(Number.isInteger(taskId as number) ? taskId : null)
  })

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
    // 因本任务被级联阻塞的下游（note 带依赖阻塞前缀）递归复位——依赖门控会让它们按拓扑顺序等待，不会抢跑。
    // 递归是必须的：深依赖链（A→B→C，A 放弃时 B、C 都被阻塞，C 的 note 指向 B 而非 A）要一路解到底
    const siblings = listTasks(task.project_id)
    const resetDepBlockedDownstream = (rootId: number): void => {
      const re = new RegExp(`^(【依赖阻塞】前置任务|\\[Dependency blocked\\] Prerequisite task) #${rootId}(?![0-9])`)
      for (const downstream of siblings) {
        if (downstream.status !== 'blocked' || !downstream.review_notes) continue
        if (!re.test(downstream.review_notes)) continue
        const reset = updateTask(downstream.id, { status: 'assigned', review_notes: null })
        broadcast('task', reset)
        logEvent('task.dep_unblocked', null, { id: downstream.id, dep: rootId })
        downstream.status = 'assigned' // 防重复处理
        resetDepBlockedDownstream(downstream.id) // 传递性解锁下游的下游
      }
    }
    resetDepBlockedDownstream(id)
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
  app.get('/api/usage', async () => ({ total: usageSummary(), byAgent: usageByAgent(), byModel: usageByModel() }))

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

  // ---- 用户自定义技能（注入角色系统提示词；改动在 agent 下次会话启动时生效） ----
  app.get('/api/skills', async () => listSkills())

  app.post<{ Body: { name: string; description?: string; content: string; roles?: string[]; enabled?: boolean } }>('/api/skills', async (req, reply) => {
    const b = req.body ?? ({} as never)
    if (!b.name?.trim() || !b.content?.trim()) return reply.code(400).send({ error: 'name 和 content 必填' })
    const roles = Array.isArray(b.roles) && b.roles.length > 0 ? b.roles : ['all']
    const row = addSkill({ name: b.name.trim(), description: b.description?.trim(), content: b.content.trim(), roles, enabled: b.enabled })
    logEvent('skill.created', 'user', { id: row.id, name: row.name, roles })
    return row
  })

  app.put<{ Params: { id: string }; Body: Partial<{ name: string; description: string | null; content: string; roles: string[]; enabled: boolean }> }>(
    '/api/skills/:id',
    async (req, reply) => {
      const existing = getSkill(Number(req.params.id))
      if (!existing) return reply.code(404).send({ error: '技能不存在' })
      const row = updateSkill(existing.id, req.body ?? {})
      logEvent('skill.updated', 'user', { id: existing.id })
      return row
    },
  )

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req) => {
    deleteSkill(Number(req.params.id))
    return { ok: true }
  })

  // ---- 工作区可视化（只读；所有路径经 resolveSafe 防穿越/符号链接外指） ----

  /** 解析并校验项目 repo 目录；不存在返回 null（项目刚创建、initProjectRepo 未完成） */
  const repoDirOf = (projectIdRaw: string): string | null => {
    const id = Number(projectIdRaw)
    if (!Number.isInteger(id) || !getProject(id)) return null
    const repo = path.join(projectDir(id), 'repo')
    if (!existsSync(repo)) return null
    return realpathSync(repo)
  }

  app.get('/api/projects', async () => listProjects())

  app.get<{ Params: { projectId: string } }>('/api/workspace/:projectId/tree', async (req, reply) => {
    const repo = repoDirOf(req.params.projectId)
    if (!repo) return reply.code(404).send({ error: '项目或其工作区不存在' })
    return listTree(repo)
  })

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/workspace/:projectId/file', async (req, reply) => {
    const repo = repoDirOf(req.params.projectId)
    if (!repo) return reply.code(404).send({ error: '项目或其工作区不存在' })
    const rel = req.query.path ?? ''
    if (!rel) return reply.code(400).send({ error: 'path 必填' })
    const abs = resolveSafe(repo, rel)
    if (!abs) return reply.code(403).send({ error: '路径越界' })
    if (!existsSync(abs)) return reply.code(404).send({ error: '文件不存在' })
    const result = readWorkspaceFile(abs)
    if (result.kind === 'too_large') return reply.code(413).send({ error: '文件过大', size: result.size })
    if (result.kind === 'binary') return { binary: true, size: result.size }
    return { content: result.content, size: result.size }
  })

  app.get<{ Params: { projectId: string; taskId: string } }>('/api/workspace/:projectId/tasks/:taskId/diff', async (req, reply) => {
    const pid = Number(req.params.projectId)
    const repo = repoDirOf(req.params.projectId)
    if (!repo) return reply.code(404).send({ error: '项目或其工作区不存在' })
    const task = getTask(Number(req.params.taskId))
    if (!task || task.project_id !== pid) return reply.code(404).send({ error: '任务不存在' })
    const dir = projectDir(pid)
    // 分支还活着（进行中/blocked/retry 重开）→ 实时 diff；已合并 → merge commit 追溯
    const branchAlive = task.branch
      ? await git(['rev-parse', '--verify', task.branch], repo).then(() => true).catch(() => false)
      : false
    if (branchAlive && task.branch) {
      return { source: 'branch', diff: await taskDiff(dir, task.branch) }
    }
    const merged = await mergedTaskDiff(dir, task.id)
    if (merged == null) return reply.code(404).send({ error: 'diff 不可追溯（分支已删且无合并记录）' })
    return { source: 'merge', diff: merged }
  })

  app.get<{ Params: { projectId: string } }>('/api/workspace/:projectId/archive.zip', async (req, reply) => {
    const repo = repoDirOf(req.params.projectId)
    if (!repo) return reply.code(404).send({ error: '项目或其工作区不存在' })
    const hasCommit = await git(['rev-parse', '--verify', 'HEAD'], repo).then(() => true).catch(() => false)
    if (!hasCommit) return reply.code(409).send({ error: '仓库还没有任何提交' })
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="project-${req.params.projectId}.zip"`)
    return reply.send(gitArchiveStream(repo))
  })

  app.get<{ Params: { projectId: string; '*': string } }>('/api/workspace/:projectId/preview/*', async (req, reply) => {
    const repo = repoDirOf(req.params.projectId)
    if (!repo) return reply.code(404).send({ error: '项目或其工作区不存在' })
    let rel = decodeURIComponent(req.params['*'] ?? '')
    if (!rel || rel.endsWith('/')) rel += 'index.html'
    const abs = resolveSafe(repo, rel)
    if (!abs) return reply.code(403).send({ error: '路径越界' })
    if (!existsSync(abs)) return reply.code(404).send({ error: '文件不存在' })
    const result = readWorkspaceFile(abs)
    reply.header('Cache-Control', 'no-store') // agent 随时改文件
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', 'sandbox allow-scripts') // 直接开新标签访问也受沙箱约束
    reply.header('Content-Type', mimeFor(abs))
    if (result.kind === 'too_large') return reply.code(413).send('file too large')
    if (result.kind === 'binary') return reply.send(readFileSync(abs))
    return reply.send(result.content)
  })

  // ---- 模型提供商（api_key 只进本地库，出接口一律脱敏；绝不进 /api/state 与 WS） ----
  const providerBodySchema = z.object({
    id: z.string().regex(PROVIDER_ID_RE, 'id 只能是小写字母/数字/-/_，最长 32'),
    name: z.string().min(1),
    base_url: z.string().regex(/^https?:\/\//, 'base_url 必须是 http(s) URL'),
    api_key: z.string().optional(),
    small_fast_model: z.string().nullish(),
    balance_adapter: z.enum(['none', 'deepseek', 'moonshot']).default('none'),
    recharge_url: z.string().nullish(),
    models: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().optional(),
          input_per_mtok: z.number().nonnegative().optional(),
          output_per_mtok: z.number().nonnegative().optional(),
          cache_read_per_mtok: z.number().nonnegative().optional(),
          cache_write_per_mtok: z.number().nonnegative().optional(),
          supports_effort: z.boolean().optional(),
        }),
      )
      .default([]),
  })

  app.get('/api/providers', async () => listProviders().map(maskProvider))
  app.get('/api/providers/presets', async () => PROVIDER_PRESETS)

  app.post('/api/providers', async (req, reply) => {
    const parsed = providerBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    const b = parsed.data
    if (getProvider(b.id)) return reply.code(409).send({ error: `提供商 ${b.id} 已存在` })
    const row = upsertProvider({
      id: b.id,
      name: b.name,
      base_url: b.base_url.replace(/\/+$/, ''),
      api_key: b.api_key ?? '',
      small_fast_model: b.small_fast_model ?? null,
      balance_adapter: b.balance_adapter,
      recharge_url: b.recharge_url ?? null,
      models_json: JSON.stringify(b.models),
    })
    logEvent('provider.created', null, { id: row.id, name: row.name })
    return maskProvider(row)
  })

  app.put<{ Params: { id: string } }>('/api/providers/:id', async (req, reply) => {
    const existing = getProvider(req.params.id)
    if (!existing) return reply.code(404).send({ error: '提供商不存在' })
    const parsed = providerBodySchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    const b = parsed.data
    const row = upsertProvider({
      id: existing.id, // id 不可改（是 model.<role> 引用的前缀）
      name: b.name ?? existing.name,
      base_url: (b.base_url ?? existing.base_url).replace(/\/+$/, ''),
      // key 留空/缺省 = 保留原值（前端编辑表单不回显 key）
      api_key: b.api_key?.trim() ? b.api_key.trim() : existing.api_key,
      small_fast_model: b.small_fast_model !== undefined ? (b.small_fast_model ?? null) : existing.small_fast_model,
      balance_adapter: b.balance_adapter ?? existing.balance_adapter,
      recharge_url: b.recharge_url !== undefined ? (b.recharge_url ?? null) : existing.recharge_url,
      models_json: b.models ? JSON.stringify(b.models) : existing.models_json,
    })
    logEvent('provider.updated', null, { id: row.id })
    return maskProvider(row)
  })

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req, reply) => {
    const existing = getProvider(req.params.id)
    if (!existing) return reply.code(404).send({ error: '提供商不存在' })
    // 引用该提供商的角色重置回默认模型，避免下次建会话走 fallback
    const resetRoles: string[] = []
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      if (!key.startsWith('model.')) continue
      if (getSetting(key).startsWith(`${existing.id}/`)) {
        updateSettings({ [key]: SETTING_DEFAULTS[key] })
        resetRoles.push(key.slice('model.'.length))
      }
    }
    deleteProvider(existing.id)
    logEvent('provider.deleted', null, { id: existing.id, reset_roles: resetRoles })
    if (resetRoles.length > 0) broadcast('settings', settingsWithDefaults())
    return { ok: true, reset_roles: resetRoles }
  })

  // 余额代查：key 不下发浏览器、第三方接口有 CORS，必须服务端代理；60s 缓存防连点
  const balanceCache = new Map<string, { at: number; data: BalanceEntry[] | null }>()
  app.get<{ Params: { id: string }; Querystring: { force?: string } }>('/api/providers/:id/balance', async (req, reply) => {
    const provider = getProvider(req.params.id)
    if (!provider) return reply.code(404).send({ error: '提供商不存在' })
    const cached = balanceCache.get(provider.id)
    if (cached && Date.now() - cached.at < 60_000 && !req.query.force) {
      return { balance: cached.data, cached: true }
    }
    try {
      const data = await fetchBalance(provider)
      balanceCache.set(provider.id, { at: Date.now(), data })
      return { balance: data }
    } catch (err) {
      return { balance: null, error: (err as Error).message.slice(0, 200) }
    }
  })
}
