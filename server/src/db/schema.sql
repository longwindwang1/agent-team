CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  requirement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', -- idle|running|paused|done|failed
  budget_usd REAL NOT NULL DEFAULT 10.0,
  test_cmd TEXT, -- 自测门命令（kickoff 时协调者声明，如 node --test / npm test）；NULL = 跳过自测门
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
  status TEXT NOT NULL DEFAULT 'backlog', -- backlog|assigned|in_progress|review|qa|challenge|final|done|blocked
  assignee TEXT,
  priority INTEGER NOT NULL DEFAULT 0, -- 1 = 用户点名优先（对话中的修改要求），调度时插队
  deps TEXT NOT NULL DEFAULT '[]', -- JSON int[]：依赖的任务 id，全部 done 才可调度
  owns_files TEXT NOT NULL DEFAULT '[]', -- JSON string[]：本任务独占创建/修改的文件（防并行冲突）
  worktree TEXT,
  branch TEXT,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  review_notes TEXT,
  verdicts TEXT, -- JSON {qa?: string, challenge?: string}：质检结论摘要，终审 brief 引用；落库使重启不丢
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
  task_id INTEGER, -- 非空 = 任务级对话线程（用户按任务提问/提要求）
  project_id INTEGER, -- 对话消息所属项目（用于按项目隔离对话线程）
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
  model TEXT, -- 原始 settings 值（如 deepseek/deepseek-v4-flash），旧行为 NULL
  project_id INTEGER, -- 归属项目；迁移前的旧行为 NULL（历史项目，不计入任何项目预算）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 第三方模型提供商（Anthropic 兼容端点）。api_key 明文存本地库（data/ 已 gitignore），出 API 一律脱敏
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, -- ^[a-z0-9_-]{1,32}$，作为 model.<role> 值的前缀（"id/modelId"）
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  small_fast_model TEXT, -- 非空时注入 ANTHROPIC_SMALL_FAST_MODEL
  balance_adapter TEXT NOT NULL DEFAULT 'none', -- none|deepseek|moonshot
  recharge_url TEXT,
  models_json TEXT NOT NULL DEFAULT '[]', -- [{id,label,input_per_mtok,output_per_mtok,cache_read_per_mtok,cache_write_per_mtok,supports_effort}]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- 用户自定义技能：注入到对应角色系统提示词的领域知识/规范/操作指引
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL, -- 注入提示词的正文（规范/术语/操作步骤）
  roles TEXT NOT NULL DEFAULT '["all"]', -- JSON string[]：适用角色 id，["all"] = 全体
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户自定义 MCP 服务器：按角色注入 agent 会话（扩展其可用工具）。
-- env / headers 可能含密钥：明文存本地库（data/ 已 gitignore），出 API 一律脱敏；绝不进 /api/state、WS、events。
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,               -- ^[a-zA-Z0-9_-]{1,32}$；作 mcpServers 的 key + 工具前缀 mcp__<name>__
  description TEXT,
  transport TEXT NOT NULL DEFAULT 'stdio', -- stdio | sse | http
  command TEXT,                            -- stdio: 可执行命令
  args TEXT NOT NULL DEFAULT '[]',         -- stdio: JSON string[]
  env TEXT NOT NULL DEFAULT '{}',          -- stdio: JSON Record<string,string>（含密钥）
  url TEXT,                                -- sse/http: 端点 URL
  headers TEXT NOT NULL DEFAULT '{}',      -- sse/http: JSON Record<string,string>（含密钥）
  roles TEXT NOT NULL DEFAULT '["all"]',   -- JSON string[]：适用角色 id，["all"] = 全体
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
