export type AgentId = 'coordinator' | 'architect' | 'frontend' | 'backend' | 'reviewer' | 'qa' | 'challenger' | 'ba' | 'devops' | 'scribe'

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting_approval' | 'error'

export type TaskStatus = 'backlog' | 'assigned' | 'in_progress' | 'review' | 'qa' | 'challenge' | 'done' | 'blocked'

export interface ProjectRow {
  id: number
  name: string
  requirement: string
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed'
  budget_usd: number
  created_at: string
  updated_at: string
}

export interface AgentRow {
  id: AgentId
  name: string
  role: string
  session_id: string | null
  status: AgentStatus
  status_detail: string | null
  model: string
  last_active_at: string | null
}

export interface TaskRow {
  id: number
  project_id: number
  title: string
  description: string | null
  status: TaskStatus
  assignee: AgentId | null
  priority: number
  worktree: string | null
  branch: string | null
  review_cycles: number
  review_notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface MeetingRow {
  id: number
  project_id: number
  type: 'kickoff' | 'design_review' | 'standup' | 'retro' | 'adhoc'
  topic: string
  status: 'open' | 'closed'
  summary: string | null
  created_at: string
  closed_at: string | null
}

export interface MessageRow {
  id: number
  meeting_id: number | null
  from_agent: string
  to_agent: string | null
  content: string
  created_at: string
}

export interface ApprovalRow {
  id: number
  project_id: number | null
  requested_by: string
  title: string
  context: string | null
  options: string | null
  recommendation: string | null
  status: 'pending' | 'approved' | 'rejected'
  decision: string | null
  comment: string | null
  created_at: string
  decided_at: string | null
}

export interface ReportRow {
  id: number
  project_id: number | null
  period_start: string | null
  period_end: string | null
  markdown: string
  stats: string | null
  created_at: string
}

export interface UsageSummary {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  calls: number
}

export interface EventRow {
  id: number
  type: string
  agent_id: string | null
  payload: string | null
  created_at: string
}

export interface LessonRow {
  id: number
  project_id: number | null
  source_type: 'task' | 'meeting' | 'approval' | 'manual' | 'retro'
  source_id: number | null
  tags: string | null
  content: string
  created_by: string
  pinned: number
  created_at: string
}
