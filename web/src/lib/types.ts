export type AgentId = 'coordinator' | 'architect' | 'frontend' | 'backend' | 'reviewer' | 'qa' | 'challenger' | 'ba' | 'devops' | 'scribe'

export interface Project {
  id: number
  name: string
  requirement: string
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed'
  budget_usd: number
  created_at: string
  updated_at: string
}

export interface Agent {
  id: AgentId
  name: string
  role: string
  session_id: string | null
  status: 'idle' | 'thinking' | 'working' | 'waiting_approval' | 'error'
  status_detail: string | null
  model: string
  last_active_at: string | null
}

export interface Task {
  id: number
  project_id: number
  title: string
  description: string | null
  status: 'backlog' | 'assigned' | 'in_progress' | 'review' | 'qa' | 'challenge' | 'final' | 'done' | 'blocked'
  assignee: AgentId | null
  priority: number
  deps: string // JSON int[]
  owns_files: string // JSON string[]
  worktree: string | null
  branch: string | null
  review_cycles: number
  review_notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Meeting {
  id: number
  project_id: number
  type: 'kickoff' | 'design_review' | 'standup' | 'retro' | 'adhoc'
  topic: string
  status: 'open' | 'closed'
  summary: string | null
  created_at: string
  closed_at: string | null
}

export interface Message {
  task_id: number | null
  project_id: number | null
  id: number
  meeting_id: number | null
  from_agent: string
  to_agent: string | null
  content: string
  created_at: string
}

export interface Approval {
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

export interface Report {
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

export interface Lesson {
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

export interface Skill {
  id: number
  name: string
  description: string | null
  content: string
  roles: string // JSON string[]
  enabled: number
  created_at: string
  updated_at: string
}

// ---------- 用户自定义 MCP 服务器（后端已脱敏：env/headers 的值为掩码 ••••••） ----------
export interface McpServer {
  id: number
  name: string
  description: string | null
  transport: 'stdio' | 'sse' | 'http'
  command: string | null
  args: string[]
  env: Record<string, string> // 值已脱敏
  url: string | null
  headers: Record<string, string> // 值已脱敏
  roles: string[]
  enabled: number
  created_at: string
  updated_at: string
}

export interface AppState {
  project: Project | null
  agents: Agent[]
  tasks: Task[]
  meetings: Meeting[]
  approvals: Approval[]
  reports: Report[]
  usage: { total: UsageSummary; byAgent: Array<{ agent_id: string } & UsageSummary> }
  events: EventRow[]
  settings: Record<string, string>
}

export interface WsMsg {
  type: 'event' | 'message' | 'agent_status' | 'task' | 'approval' | 'report' | 'project' | 'stream' | 'settings'
  payload: unknown
}

// ---------- 模型提供商（后端已脱敏，不含 api_key） ----------
export interface ProviderModel {
  id: string
  label?: string
  input_per_mtok?: number
  output_per_mtok?: number
  cache_read_per_mtok?: number
  cache_write_per_mtok?: number
  supports_effort?: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  base_url: string
  small_fast_model: string | null
  balance_adapter: string
  recharge_url: string | null
  models: ProviderModel[]
  has_key: boolean
  key_tail: string
}

export interface ProviderPreset {
  id: string
  name: string
  base_url: string
  small_fast_model: string | null
  balance_adapter: string
  recharge_url: string
  models: ProviderModel[]
  note?: string
}

export interface BalanceEntry {
  currency: string
  amount: number
}

export const AGENT_META: Record<AgentId, { label: string; color: string; bg: string; border: string }> = {
  coordinator: { label: '协调者', color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30' },
  architect: { label: '架构师', color: 'text-violet-400', bg: 'bg-violet-400/10', border: 'border-violet-400/30' },
  frontend: { label: '前端工程师', color: 'text-sky-400', bg: 'bg-sky-400/10', border: 'border-sky-400/30' },
  backend: { label: '后端工程师', color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  reviewer: { label: '审查员', color: 'text-rose-400', bg: 'bg-rose-400/10', border: 'border-rose-400/30' },
  qa: { label: 'QA 工程师', color: 'text-cyan-400', bg: 'bg-cyan-400/10', border: 'border-cyan-400/30' },
  challenger: { label: '质疑者', color: 'text-orange-400', bg: 'bg-orange-400/10', border: 'border-orange-400/30' },
  ba: { label: '需求分析师', color: 'text-lime-400', bg: 'bg-lime-400/10', border: 'border-lime-400/30' },
  devops: { label: 'DevOps 工程师', color: 'text-teal-400', bg: 'bg-teal-400/10', border: 'border-teal-400/30' },
  scribe: { label: '书记官', color: 'text-stone-400', bg: 'bg-stone-400/10', border: 'border-stone-400/30' },
}

export function agentMeta(id: string) {
  return (
    AGENT_META[id as AgentId] ?? {
      label: id === 'user' ? '用户' : id === 'system' ? '系统' : id,
      color: 'text-zinc-300',
      bg: 'bg-zinc-400/10',
      border: 'border-zinc-500/30',
    }
  )
}
