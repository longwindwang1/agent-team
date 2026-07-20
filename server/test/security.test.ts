import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// 纯模块：不 import db
import { isAllowedOrigin, tokenMatches } from '../src/lib/auth'
import { mcpBoundaryViolation } from '../src/orchestrator/policies'

describe('tokenMatches（恒时比较）', () => {
  it('相等 → true；不等/空/长度不同 → false', () => {
    expect(tokenMatches('secret-1', 'secret-1')).toBe(true)
    expect(tokenMatches('secret-2', 'secret-1')).toBe(false)
    expect(tokenMatches(undefined, 'secret-1')).toBe(false)
    expect(tokenMatches('', 'secret-1')).toBe(false)
    expect(tokenMatches('short', 'a-much-longer-token')).toBe(false)
    expect(tokenMatches('x', '')).toBe(false)
  })
})

describe('isAllowedOrigin（CORS 白名单）', () => {
  it('无 Origin / 回环任意端口恒放行', () => {
    expect(isAllowedOrigin(undefined, '')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5174', '')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3100', '')).toBe(true)
    expect(isAllowedOrigin('https://localhost', '')).toBe(true)
  })
  it('外部 Origin 默认拒绝，白名单命中才放行（前缀碰撞不算命中）', () => {
    expect(isAllowedOrigin('http://192.168.1.5:5174', '')).toBe(false)
    expect(isAllowedOrigin('http://evil.com', 'http://192.168.1.5:5174')).toBe(false)
    expect(isAllowedOrigin('http://192.168.1.5:5174', 'http://192.168.1.5:5174, http://a.b')).toBe(true)
    expect(isAllowedOrigin('http://localhost.evil.com', '')).toBe(false)
  })
})

describe('mcpBoundaryViolation（MCP 写工具工作区边界）', () => {
  const cwd = path.resolve('D:\\ws\\project-1')
  const inside = path.join(cwd, 'repo', 'a.txt')
  const outside = 'C:\\Windows\\System32\\hosts'

  it('写类工具带工作区外绝对路径 → 违规；工作区内 → 放行', () => {
    expect(mcpBoundaryViolation('mcp__fs__write_file', { path: outside }, cwd)).toBe(outside)
    expect(mcpBoundaryViolation('mcp__fs__write_file', { path: inside }, cwd)).toBeNull()
  })
  it('file:// URL 同样受限；嵌套参数与数组也扫', () => {
    const outUrl = pathToFileURL(outside).href
    expect(mcpBoundaryViolation('mcp__fs__create_directory', { opts: { target: outUrl } }, cwd)).toBe(outUrl)
    expect(mcpBoundaryViolation('mcp__fs__move_file', { batch: [{ to: outside }] }, cwd)).toBe(outside)
    expect(mcpBoundaryViolation('mcp__fs__save', { u: pathToFileURL(inside).href }, cwd)).toBeNull()
  })
  it('读类工具 / collab / 非 MCP / 相对路径不检查', () => {
    expect(mcpBoundaryViolation('mcp__fs__read_file', { path: outside }, cwd)).toBeNull()
    expect(mcpBoundaryViolation('mcp__collab__create_task', { title: outside }, cwd)).toBeNull()
    expect(mcpBoundaryViolation('Bash', { command: outside }, cwd)).toBeNull()
    expect(mcpBoundaryViolation('mcp__fs__write_file', { path: 'sub/a.txt' }, cwd)).toBeNull()
  })
  it('大小写不敏感（Windows）与跨盘路径', () => {
    if (process.platform === 'win32') {
      expect(mcpBoundaryViolation('mcp__fs__write_file', { path: inside.toUpperCase() }, cwd)).toBeNull()
    }
    expect(mcpBoundaryViolation('mcp__fs__write_file', { path: 'E:\\other\\x.txt' }, cwd)).toBe('E:\\other\\x.txt')
  })
})
