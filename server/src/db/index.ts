import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, WORKSPACES_DIR } from '../lib/paths'

// 常量从 lib/paths.ts 迁出后在此 re-export，既有导入点（routes/engine 等）无需改动
export { ROOT_DIR, DATA_DIR, WORKSPACES_DIR } from '../lib/paths'

const here = path.dirname(fileURLToPath(import.meta.url))

let real: Database.Database | null = null

/**
 * 显式初始化数据库（幂等）：生产默认 data/meeting.db；测试传 ':memory:'。
 * 建库/建表/迁移全部发生在这里——模块导入零副作用（可测性的地基）。
 */
export function initDb(dbPath?: string): Database.Database {
  if (real) return real
  const target = dbPath ?? path.join(DATA_DIR, 'meeting.db')
  const isMemory = target === ':memory:'
  if (!isMemory) {
    mkdirSync(path.dirname(target), { recursive: true })
    mkdirSync(WORKSPACES_DIR, { recursive: true })
  }
  real = new Database(target)
  if (!isMemory) real.pragma('journal_mode = WAL') // WAL 对 :memory: 无意义，显式跳过
  real.exec(readFileSync(path.join(here, 'schema.sql'), 'utf-8'))

  // 旧库幂等迁移（CREATE IF NOT EXISTS 不会给已有表加列）
  const migrations = [
    'ALTER TABLE usage_log ADD COLUMN model TEXT',
    'ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE tasks ADD COLUMN deps TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE tasks ADD COLUMN owns_files TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE messages ADD COLUMN task_id INTEGER',
    'ALTER TABLE messages ADD COLUMN project_id INTEGER',
    'ALTER TABLE projects ADD COLUMN test_cmd TEXT',
    'ALTER TABLE usage_log ADD COLUMN project_id INTEGER',
  ]
  for (const sql of migrations) {
    try {
      real.exec(sql)
    } catch {
      // 列已存在
    }
  }
  // 索引必须在 ALTER 之后建（老库的 project_id 列先由上面补齐；放 schema.sql 会先于迁移执行而失败）
  real.exec('CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_log(project_id)')
  return real
}

/** 关闭并重置（测试 teardown 用；生产不调用） */
export function closeDb(): void {
  real?.close()
  real = null
}

/**
 * 兼容既有 `import { db }` 的 44+ 个 dao 调用点：Proxy 转发到真实实例。
 * 未 initDb 就访问 → 立刻抛带名字的错误（fail-fast），而不是静默建出生产库文件。
 * 方法必须 bind 到真实实例——better-sqlite3 原生方法对 this 敏感。
 */
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_t, prop) {
    if (!real) throw new Error("数据库尚未初始化：先调用 initDb()（测试请用 initDb(':memory:')）")
    const v = (real as unknown as Record<string | symbol, unknown>)[prop]
    return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(real) : v
  },
})
