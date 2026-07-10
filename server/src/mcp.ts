import type { McpServerRow } from './types'

/** MCP server 名：作 mcpServers 的 key 与工具前缀 mcp__<name>__，须唯一且合法 */
export const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/
/** 出 API 时密钥值的占位符；回传等于此值 = 保留原值（见 mergeSecretMap） */
export const SECRET_MASK = '••••••'

export interface MaskedMcpServer {
  id: number
  name: string
  description: string | null
  transport: string
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

export function safeArr(json: string): string[] {
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function safeObj(json: string): Record<string, string> {
  try {
    const o = JSON.parse(json)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

function safeRoles(json: string): string[] {
  const r = safeArr(json)
  return r.length ? r : ['all']
}

function maskValues(json: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(safeObj(json))) out[k] = SECRET_MASK
  return out
}

/** env/headers 的值一律脱敏（只回 key + 掩码），绝不下发明文密钥；args/command/url 明文可见 */
export function maskMcpServer(row: McpServerRow): MaskedMcpServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: safeArr(row.args),
    env: maskValues(row.env),
    url: row.url,
    headers: maskValues(row.headers),
    roles: safeRoles(row.roles),
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** SDK mcpServers 配置的可序列化子集（stdio/sse/http）——结构上兼容 SDK 的 McpServerConfig */
export type BuiltMcpConfig =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

/** 单条记录 → SDK mcpServers 配置；字段缺失（stdio 无 command / 远程无 url）返回 null 跳过 */
export function buildMcpConfig(s: McpServerRow): BuiltMcpConfig | null {
  if (s.transport === 'http') {
    if (!s.url) return null
    const headers = safeObj(s.headers)
    return { type: 'http', url: s.url, ...(Object.keys(headers).length ? { headers } : {}) }
  }
  if (s.transport === 'sse') {
    if (!s.url) return null
    const headers = safeObj(s.headers)
    return { type: 'sse', url: s.url, ...(Object.keys(headers).length ? { headers } : {}) }
  }
  if (!s.command) return null
  const env = safeObj(s.env)
  return { type: 'stdio', command: s.command, args: safeArr(s.args), ...(Object.keys(env).length ? { env } : {}) }
}

/**
 * 合并密钥 map（env / headers）并回 JSON 字符串存库：
 * - provided 缺省 → 保留原值整体
 * - provided 提供 → 逐键合并：值 === 掩码则保留原值，否则用新值；provided 未含的键被移除
 * 前端拿到的是脱敏后的 map（值均为掩码），原样回传即保留；改动的键传新值；删掉的行即移除。
 */
export function mergeSecretMap(existingJson: string, provided?: Record<string, string>): string {
  const existing = safeObj(existingJson)
  if (!provided) return JSON.stringify(existing)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(provided)) {
    out[k] = v === SECRET_MASK ? existing[k] ?? '' : v
  }
  return JSON.stringify(out)
}
