CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  requirement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', -- idle|running|paused|done|failed
  budget_usd REAL NOT NULL DEFAULT 10.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, -- coordinator|architect|frontend|backend|reviewer|qa
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle', -- idle|thinking|working|waiting_approval|error
  status_detail TEXT,
  model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog', -- backlog|assigned|in_progress|review|qa|done|blocked
  assignee TEXT,
  worktree TEXT,
  branch TEXT,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  review_notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- kickoff|design_review|standup|retro|adhoc
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|closed
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER, -- NULL = direct/system message
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  requested_by TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT,
  options TEXT, -- JSON string[]
  recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  decision TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  period_start TEXT,
  period_end TEXT,
  markdown TEXT NOT NULL,
  stats TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER, -- NULL = 全局（跨项目）
  source_type TEXT NOT NULL, -- task|meeting|approval|manual|retro
  source_id INTEGER,
  tags TEXT,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id);
