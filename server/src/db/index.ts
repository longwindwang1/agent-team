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
