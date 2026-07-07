import { db } from './index'
import type {
  AgentId,
  AgentRow,
  AgentStatus,
  ApprovalRow,
  EventRow,
  LessonRow,
  MeetingRow,
  MessageRow,
  ProjectRow,
  ReportRow,
  TaskRow,
  TaskStatus,
  UsageSummary,
} from '../types'
import type { ProviderRow } from '../providers'

// ---------- projects ----------
export function createProject(name: string, requirement: string, budgetUsd: number): ProjectRow {
  const info = db
    .prepare('INSERT INTO projects (name, requirement, budget_usd) VALUES (?, ?, ?)')
    .run(name, requirement, budgetUsd)
  return getProject(Number(info.lastInsertRowid))!
}

export function getProject(id: number): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
}

export function currentProject(): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects ORDER BY id DESC LIMIT 1').get() as ProjectRow | undefined
}

export function setProjectStatus(id: number, status: ProjectRow['status']): void {
  db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
}

export function updateProjectBudget(id: number, budgetUsd: number): void {
  db.prepare("UPDATE projects SET budget_usd = ?, updated_at = datetime('now') WHERE id = ?").run(budgetUsd, id)
}

// ---------- agents ----------
export function upsertAgent(id: AgentId, name: string, role: string, model: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, model) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, model = excluded.model`,
  ).run(id, name, role, model)
}

export function listAgents(): AgentRow[] {
  return db.prepare('SELECT * FROM agents ORDER BY rowid').all() as AgentRow[]
}

export function setAgentStatus(id: AgentId, status: AgentStatus, detail?: string): void {
  db.prepare(
    "UPDATE agents SET status = ?, status_detail = ?, last_active_at = datetime('now') WHERE id = ?",
  ).run(status, detail ?? null, id)
}

export function setAgentSession(id: AgentId, sessionId: string | null): void {
  db.prepare('UPDATE agents SET session_id = ? WHERE id = ?').run(sessionId, id)
}

export function setAgentModel(id: AgentId, model: string): void {
  db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(model, id)
}

// ---------- tasks ----------
export function createTask(input: {
  project_id: number
  title: string
  description?: string
  assignee?: AgentId
  created_by?: string
  priority?: number
}): TaskRow {
  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, title, description, assignee, created_by, status, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.description ?? null,
      input.assignee ?? null,
      input.created_by ?? null,
      input.assignee ? 'assigned' : 'backlog',
      input.priority ?? 0,
    )
  return getTask(Number(info.lastInsertRowid))!
}

export function getTask(id: number): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
}

export function listTasks(projectId?: number): TaskRow[] {
  if (projectId != null) {
    return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId) as TaskRow[]
  }
  return db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[]
}

export function updateTask(
  id: number,
  patch: Partial<Pick<TaskRow, 'status' | 'assignee' | 'worktree' | 'branch' | 'review_cycles' | 'review_notes' | 'description'>>,
): TaskRow | undefined {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`)
    values.push(v)
  }
  if (fields.length > 0) {
    db.prepare(`UPDATE tasks SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
  }
  return getTask(id)
}

export function setTaskStatus(id: number, status: TaskStatus, note?: string): TaskRow | undefined {
  return updateTask(id, { status, ...(note !== undefined ? { review_notes: note } : {}) })
}

// ---------- meetings & messages ----------
export function createMeeting(projectId: number, type: MeetingRow['type'], topic: string): MeetingRow {
  const info = db.prepare('INSERT INTO meetings (project_id, type, topic) VALUES (?, ?, ?)').run(projectId, type, topic)
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(Number(info.lastInsertRowid)) as MeetingRow
}

export function getMeetingProjectId(meetingId: number): number | null {
  const row = db.prepare('SELECT project_id FROM meetings WHERE id = ?').get(meetingId) as { project_id: number } | undefined
  return row?.project_id ?? null
}

export function closeMeeting(id: number, summary: string): void {
  db.prepare("UPDATE meetings SET status = 'closed', summary = ?, closed_at = datetime('now') WHERE id = ?").run(summary, id)
}

export function listMeetings(projectId?: number): MeetingRow[] {
  if (projectId != null) {
    return db.prepare('SELECT * FROM meetings WHERE project_id = ? ORDER BY id DESC').all(projectId) as MeetingRow[]
  }
  return db.prepare('SELECT * FROM meetings ORDER BY id DESC').all() as MeetingRow[]
}

export function addMessage(input: {
  meeting_id?: number | null
  from_agent: string
  to_agent?: string | null
  content: string
}): MessageRow {
  const info = db
    .prepare('INSERT INTO messages (meeting_id, from_agent, to_agent, content) VALUES (?, ?, ?, ?)')
    .run(input.meeting_id ?? null, input.from_agent, input.to_agent ?? null, input.content)
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)) as MessageRow
}

export function listMessages(meetingId: number): MessageRow[] {
  return db.prepare('SELECT * FROM messages WHERE meeting_id = ? ORDER BY id').all(meetingId) as MessageRow[]
}

/** 团队频道：私信与系统消息（不属于任何会议） */
export function listDirectMessages(): MessageRow[] {
  return db.prepare('SELECT * FROM messages WHERE meeting_id IS NULL ORDER BY id').all() as MessageRow[]
}

// ---------- approvals ----------
export function createApproval(input: {
  project_id?: number | null
  requested_by: string
  title: string
  context?: string
  options?: string[]
  recommendation?: string
}): ApprovalRow {
  const info = db
    .prepare(
      `INSERT INTO approvals (project_id, requested_by, title, context, options, recommendation)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id ?? null,
      input.requested_by,
      input.title,
      input.context ?? null,
      input.options ? JSON.stringify(input.options) : null,
      input.recommendation ?? null,
    )
  return getApproval(Number(info.lastInsertRowid))!
}

export function getApproval(id: number): ApprovalRow | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined
}

export function decideApproval(id: number, status: 'approved' | 'rejected', decision?: string, comment?: string): ApprovalRow | undefined {
  db.prepare(
    "UPDATE approvals SET status = ?, decision = ?, comment = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'",
  ).run(status, decision ?? null, comment ?? null, id)
  return getApproval(id)
}

export function listApprovals(): ApprovalRow[] {
  return db.prepare('SELECT * FROM approvals ORDER BY id DESC').all() as ApprovalRow[]
}

export function pendingApprovals(): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as ApprovalRow[]
}

// ---------- reports ----------
export function addReport(input: {
  project_id?: number | null
  period_start?: string
  period_end?: string
  markdown: string
  stats?: unknown
}): ReportRow {
  const info = db
    .prepare('INSERT INTO reports (project_id, period_start, period_end, markdown, stats) VALUES (?, ?, ?, ?, ?)')
    .run(
      input.project_id ?? null,
      input.period_start ?? null,
      input.period_end ?? null,
      input.markdown,
      input.stats ? JSON.stringify(input.stats) : null,
    )
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(info.lastInsertRowid)) as ReportRow
}

export function listReports(): ReportRow[] {
  return db.prepare('SELECT * FROM reports ORDER BY id DESC').all() as ReportRow[]
}

export function lastReportTime(): string | undefined {
  const row = db.prepare('SELECT created_at FROM reports ORDER BY id DESC LIMIT 1').get() as { created_at: string } | undefined
  return row?.created_at
}

export function lastReportStats(): Record<string, unknown> | null {
  const row = db.prepare('SELECT stats FROM reports ORDER BY id DESC LIMIT 1').get() as { stats: string | null } | undefined
  if (!row?.stats) return null
  try {
    return JSON.parse(row.stats) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------- usage ----------
export function addUsage(input: {
  agent_id: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  model?: string
}): void {
  db.prepare(
    `INSERT INTO usage_log (agent_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.agent_id,
    input.input_tokens,
    input.output_tokens,
    input.cache_read_tokens,
    input.cache_write_tokens,
    input.cost_usd,
    input.model ?? null,
  )
}

export function usageSummary(sinceIso?: string): UsageSummary {
  const where = sinceIso ? 'WHERE created_at >= ?' : ''
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
              COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
              COALESCE(SUM(cost_usd),0) cost_usd, COUNT(*) calls
       FROM usage_log ${where}`,
    )
    .get(...(sinceIso ? [sinceIso] : [])) as UsageSummary
  return row
}

export function usageByAgent(): Array<{ agent_id: string } & UsageSummary> {
  return db
    .prepare(
      `SELECT agent_id, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
              COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
              COALESCE(SUM(cost_usd),0) cost_usd, COUNT(*) calls
       FROM usage_log GROUP BY agent_id`,
    )
    .all() as Array<{ agent_id: string } & UsageSummary>
}

export function usageByModel(): Array<{ model: string } & UsageSummary> {
  return db
    .prepare(
      `SELECT COALESCE(model, '(旧记录)') model, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
              COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) cache_write_tokens,
              COALESCE(SUM(cost_usd),0) cost_usd, COUNT(*) calls
       FROM usage_log GROUP BY COALESCE(model, '(旧记录)')`,
    )
    .all() as Array<{ model: string } & UsageSummary>
}

export function listProjects(): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY id DESC').all() as ProjectRow[]
}

// ---------- providers ----------
export function listProviders(): ProviderRow[] {
  return db.prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[]
}

export function getProvider(id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
}

export function upsertProvider(input: {
  id: string
  name: string
  base_url: string
  api_key: string
  small_fast_model: string | null
  balance_adapter: string
  recharge_url: string | null
  models_json: string
}): ProviderRow {
  db.prepare(
    `INSERT INTO providers (id, name, base_url, api_key, small_fast_model, balance_adapter, recharge_url, models_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
       small_fast_model = excluded.small_fast_model, balance_adapter = excluded.balance_adapter,
       recharge_url = excluded.recharge_url, models_json = excluded.models_json,
       updated_at = datetime('now')`,
  ).run(
    input.id,
    input.name,
    input.base_url,
    input.api_key,
    input.small_fast_model,
    input.balance_adapter,
    input.recharge_url,
    input.models_json,
  )
  return getProvider(input.id)!
}

export function deleteProvider(id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id)
}

// ---------- events ----------
export function addEvent(type: string, agentId?: string | null, payload?: unknown): EventRow {
  const info = db
    .prepare('INSERT INTO events (type, agent_id, payload) VALUES (?, ?, ?)')
    .run(type, agentId ?? null, payload != null ? JSON.stringify(payload) : null)
  return db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid)) as EventRow
}

export function listEvents(limit = 100): EventRow[] {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[]
}

// ---------- lessons（团队记忆）----------
export function addLesson(input: {
  project_id?: number | null
  source_type: LessonRow['source_type']
  source_id?: number | null
  tags?: string
  content: string
  created_by?: string
  pinned?: boolean
}): LessonRow {
  const info = db
    .prepare('INSERT INTO lessons (project_id, source_type, source_id, tags, content, created_by, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      input.project_id ?? null,
      input.source_type,
      input.source_id ?? null,
      input.tags ?? null,
      input.content,
      input.created_by ?? 'system',
      input.pinned ? 1 : 0,
    )
  return db.prepare('SELECT * FROM lessons WHERE id = ?').get(Number(info.lastInsertRowid)) as LessonRow
}

export function listLessons(opts: { projectId?: number | null; q?: string; limit?: number } = {}): LessonRow[] {
  const conds: string[] = []
  const args: unknown[] = []
  if (opts.projectId !== undefined) {
    conds.push('(project_id IS NULL OR project_id = ?)')
    args.push(opts.projectId)
  }
  if (opts.q) {
    conds.push('(content LIKE ? OR tags LIKE ?)')
    args.push(`%${opts.q}%`, `%${opts.q}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db
    .prepare(`SELECT * FROM lessons ${where} ORDER BY pinned DESC, id DESC LIMIT ?`)
    .all(...args, opts.limit ?? 200) as LessonRow[]
}

export function setLessonPinned(id: number, pinned: boolean): void {
  db.prepare('UPDATE lessons SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function deleteLesson(id: number): void {
  db.prepare('DELETE FROM lessons WHERE id = ?').run(id)
}

// ---------- settings ----------
export function getSettingRaw(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}
