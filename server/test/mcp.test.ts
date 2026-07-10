import { describe, expect, it } from 'vitest'
// mcp.ts 是纯函数模块（不 import db），可直接引入
import { buildMcpConfig, maskMcpServer, mergeSecretMap, SECRET_MASK, MCP_NAME_RE } from '../src/mcp'
import type { McpServerRow } from '../src/types'

function fakeRow(over: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 1,
    name: 'filesystem',
    description: null,
    transport: 'stdio',
    command: 'npx',
    args: JSON.stringify(['-y', '@modelcontextprotocol/server-filesystem', 'D:/work']),
    env: JSON.stringify({ API_KEY: 'sk-super-secret-xyz', REGION: 'us' }),
    url: null,
    headers: JSON.stringify({}),
    roles: JSON.stringify(['backend', 'devops']),
    enabled: 1,
    created_at: '2026-07-09',
    updated_at: '2026-07-09',
    ...over,
  }
}

describe('MCP name 校验', () => {
  it('接受合法名，拒绝非法名', () => {
    expect(MCP_NAME_RE.test('filesystem')).toBe(true)
    expect(MCP_NAME_RE.test('gh-mcp_2')).toBe(true)
    expect(MCP_NAME_RE.test('bad name')).toBe(false) // 空格
    expect(MCP_NAME_RE.test('bad/name')).toBe(false) // 斜杠
    expect(MCP_NAME_RE.test('')).toBe(false)
    expect(MCP_NAME_RE.test('x'.repeat(33))).toBe(false) // 超长
  })
})

describe('maskMcpServer', () => {
  it('env/headers 的值一律脱敏，键保留，明文密钥绝不出现', () => {
    const m = maskMcpServer(fakeRow())
    expect(m.env).toEqual({ API_KEY: SECRET_MASK, REGION: SECRET_MASK })
    expect(JSON.stringify(m)).not.toContain('sk-super-secret-xyz')
  })

  it('args/command/url/roles 解析可见', () => {
    const m = maskMcpServer(fakeRow())
    expect(m.command).toBe('npx')
    expect(m.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:/work'])
    expect(m.roles).toEqual(['backend', 'devops'])
    expect(m.url).toBeNull()
  })

  it('http 传输脱敏 headers 里的密钥', () => {
    const m = maskMcpServer(
      fakeRow({ transport: 'http', command: null, args: '[]', env: '{}', url: 'https://x/mcp', headers: JSON.stringify({ Authorization: 'Bearer TOKEN123' }) }),
    )
    expect(m.headers).toEqual({ Authorization: SECRET_MASK })
    expect(JSON.stringify(m)).not.toContain('TOKEN123')
  })

  it('损坏的 JSON 安全降级为空，roles 空降级为 all', () => {
    const m = maskMcpServer(fakeRow({ env: 'not json', args: '{bad', roles: '[]' }))
    expect(m.env).toEqual({})
    expect(m.args).toEqual([])
    expect(m.roles).toEqual(['all'])
  })
})

describe('buildMcpConfig（记录 → SDK 配置）', () => {
  it('stdio：带 command/args/env（用明文，注入子进程）', () => {
    expect(buildMcpConfig(fakeRow())).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/work'],
      env: { API_KEY: 'sk-super-secret-xyz', REGION: 'us' },
    })
  })

  it('stdio：无 env 时省略 env 字段', () => {
    const cfg = buildMcpConfig(fakeRow({ env: '{}' }))
    expect(cfg).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/work'] })
    expect(cfg && 'env' in cfg).toBe(false)
  })

  it('http：带 headers', () => {
    const cfg = buildMcpConfig(fakeRow({ transport: 'http', command: null, url: 'https://x/mcp', headers: JSON.stringify({ Authorization: 'Bearer T' }) }))
    expect(cfg).toEqual({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer T' } })
  })

  it('sse：无 headers 时省略字段', () => {
    expect(buildMcpConfig(fakeRow({ transport: 'sse', command: null, url: 'https://x/sse', headers: '{}' }))).toEqual({
      type: 'sse',
      url: 'https://x/sse',
    })
  })

  it('配置不全返回 null（stdio 无 command / 远程无 url）', () => {
    expect(buildMcpConfig(fakeRow({ command: null }))).toBeNull()
    expect(buildMcpConfig(fakeRow({ transport: 'http', command: null, url: null }))).toBeNull()
  })
})

describe('mergeSecretMap（编辑时保留/覆盖密钥）', () => {
  const existing = JSON.stringify({ API_KEY: 'orig-secret', REGION: 'us' })

  it('provided 缺省 → 保留原值整体', () => {
    expect(JSON.parse(mergeSecretMap(existing, undefined))).toEqual({ API_KEY: 'orig-secret', REGION: 'us' })
  })

  it('掩码值 → 保留原密钥；新值 → 覆盖', () => {
    const merged = JSON.parse(mergeSecretMap(existing, { API_KEY: SECRET_MASK, REGION: 'eu' }))
    expect(merged).toEqual({ API_KEY: 'orig-secret', REGION: 'eu' })
  })

  it('provided 未含的键被移除（删行）', () => {
    const merged = JSON.parse(mergeSecretMap(existing, { API_KEY: SECRET_MASK }))
    expect(merged).toEqual({ API_KEY: 'orig-secret' })
  })

  it('全新键写入', () => {
    const merged = JSON.parse(mergeSecretMap('{}', { NEW: 'v' }))
    expect(merged).toEqual({ NEW: 'v' })
  })
})
