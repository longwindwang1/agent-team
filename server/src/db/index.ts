import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(here, '../../..')
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const WORKSPACES_DIR = path.join(ROOT_DIR, 'workspaces')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(WORKSPACES_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'meeting.db'))
db.pragma('journal_mode = WAL')
db.exec(readFileSync(path.join(here, 'schema.sql'), 'utf-8'))

// 旧库幂等迁移（CREATE IF NOT EXISTS 不会给已有表加列）
try {
  db.exec('ALTER TABLE usage_log ADD COLUMN model TEXT')
} catch {
  // 列已存在
}
try {
  db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN deps TEXT NOT NULL DEFAULT '[]'")
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN owns_files TEXT NOT NULL DEFAULT '[]'")
} catch {
  // 列已存在
}
try {
  db.exec('ALTER TABLE messages ADD COLUMN task_id INTEGER')
} catch {
  // 列已存在
}
try {
  db.exec('ALTER TABLE messages ADD COLUMN project_id INTEGER')
} catch {
  // 列已存在
}
