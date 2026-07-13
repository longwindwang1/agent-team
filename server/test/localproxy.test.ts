import { describe, expect, it } from 'vitest'
// findLoopbackBaseUrl 是纯函数；localproxy 模块本身 import dao（可注入 db），此处只测纯部分不触 db
import { findLoopbackBaseUrl } from '../src/localproxy'

const providers = [
  { id: 'openai', base_url: 'http://127.0.0.1:4000' },
  { id: 'deepseek', base_url: 'https://api.deepseek.com/anthropic' },
  { id: 'localhostish', base_url: 'http://localhost:5000/v1' },
  { id: 'evil', base_url: 'http://127.0.0.1.evil.com' }, // 前缀伪装，不是回环
]

describe('findLoopbackBaseUrl（哪些模型引用需要本地代理）', () => {
  it('命中回环 provider → 返回其 base_url', () => {
    expect(findLoopbackBaseUrl(['claude-opus-4-8', 'openai/gpt-5-mini'], providers)).toBe('http://127.0.0.1:4000')
    expect(findLoopbackBaseUrl(['localhostish/m1'], providers)).toBe('http://localhost:5000/v1')
  })

  it('全官方模型 / 远程端点 → null', () => {
    expect(findLoopbackBaseUrl(['claude-opus-4-8', 'claude-sonnet-5'], providers)).toBeNull()
    expect(findLoopbackBaseUrl(['deepseek/deepseek-v4-flash'], providers)).toBeNull()
  })

  it('未知 provider 前缀 / 空引用 → null', () => {
    expect(findLoopbackBaseUrl(['nope/m'], providers)).toBeNull()
    expect(findLoopbackBaseUrl([''], providers)).toBeNull()
    expect(findLoopbackBaseUrl([], providers)).toBeNull()
  })

  it('域名前缀伪装成回环（127.0.0.1.evil.com）不误判', () => {
    expect(findLoopbackBaseUrl(['evil/m'], providers)).toBeNull()
  })

  it('端口解析：URL 带端口', () => {
    const base = findLoopbackBaseUrl(['openai/gpt-5.1'], providers)!
    expect(Number(new URL(base).port)).toBe(4000)
  })
})
