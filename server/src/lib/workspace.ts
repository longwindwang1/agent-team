// 工作区可视化的纯逻辑层：路径安全、文件树、文件读取、mime 表。
// resolveSafe/isTraversal 是纯函数可直接单测；带 fs 的函数只依赖传入的 repoDir。

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'

/** 相对路径是否越界（../、绝对路径、盘符……）。传入 decode 后的原始 rel */
export function isTraversal(repoDir: string, rel: string): boolean {
  const abs = path.resolve(repoDir, rel)
  const r = path.relative(repoDir, abs)
  return r.startsWith('..') || path.isAbsolute(r)
}

/**
 * 解析 repo 内安全绝对路径；越界/符号链接外指返回 null（调用方回 403）。
 * repoDir 必须已 realpath 过；对已存在的目标再 realpath 复查，击败 symlink/junction。
 */
export function resolveSafe(repoDir: string, rel: string): string | null {
  if (isTraversal(repoDir, rel)) return null
  const abs = path.resolve(repoDir, rel)
  if (existsSync(abs)) {
    const real = realpathSync(abs)
    const r = path.relative(repoDir, real)
    if (r.startsWith('..') || path.isAbsolute(r)) return null
    return real
  }
  return abs
}

export interface TreeEntry {
  path: string // repo 相对路径，正斜杠
  type: 'file' | 'dir'
  size: number
}

const TREE_EXCLUDES = new Set(['.git', 'node_modules'])
const MAX_DEPTH = 12
const MAX_ENTRIES = 2000

/** 文件系统递归列出 repo 文件树（含未提交落盘的文件）；排除 .git/node_modules，跳过符号链接 */
export function listTree(repoDir: string): { entries: TreeEntry[]; truncated: boolean } {
  const entries: TreeEntry[] = []
  let truncated = false
  const walk = (dir: string, relBase: string, depth: number): void => {
    if (depth > MAX_DEPTH || truncated) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (TREE_EXCLUDES.has(name)) continue
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      const abs = path.join(dir, name)
      const rel = relBase ? `${relBase}/${name}` : name
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue // 符号链接不进树，杜绝外指
      if (st.isDirectory()) {
        entries.push({ path: rel, type: 'dir', size: 0 })
        walk(abs, rel, depth + 1)
      } else if (st.isFile()) {
        entries.push({ path: rel, type: 'file', size: st.size })
      }
    }
  }
  walk(repoDir, '', 0)
  return { entries, truncated }
}

export const MAX_FILE_BYTES = 512 * 1024

export type FileReadResult = { kind: 'text'; content: string; size: number } | { kind: 'binary'; size: number } | { kind: 'too_large'; size: number }

/** 读文件：512KB 上限；前 8KB 含 \0 判二进制 */
export function readWorkspaceFile(absPath: string): FileReadResult {
  const size = statSync(absPath).size
  if (size > MAX_FILE_BYTES) return { kind: 'too_large', size }
  const fd = openSync(absPath, 'r')
  try {
    const head = Buffer.alloc(Math.min(8192, size))
    readSync(fd, head, 0, head.length, 0)
    if (head.includes(0)) return { kind: 'binary', size }
  } finally {
    closeSync(fd)
  }
  return { kind: 'text', content: readFileSync(absPath, 'utf-8'), size }
}

const MIME_TABLE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
}

export function mimeFor(filePath: string): string {
  return MIME_TABLE[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}
