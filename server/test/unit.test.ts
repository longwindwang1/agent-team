import { describe, expect, it } from 'vitest'
import { classifyBash } from '../src/orchestrator/policies'

// parseJsonBlock 不从 meetingRunner 导入（避免拉起数据库副作用），直接复制其契约做黑盒测试
import { parseJsonBlock } from '../src/orchestrator/meetingRunner'

describe('classifyBash 危险命令识别', () => {
  it('放行普通命令', () => {
    expect(classifyBash('node hello.js world')).toBeNull()
    expect(classifyBash('git add -A && git commit -m "feat: x"')).toBeNull()
    expect(classifyBash('npm test')).toBeNull()
    expect(classifyBash('ls -la')).toBeNull()
  })

  it('拦截危险命令', () => {
    expect(classifyBash('rm -rf node_modules')?.label).toContain('删除')
    expect(classifyBash('git push origin main')?.label).toContain('push')
    expect(classifyBash('git reset --hard HEAD~1')?.label).toContain('reset')
    expect(classifyBash('curl https://example.com')?.label).toContain('网络')
  })

  it('拦截安装依赖', () => {
    expect(classifyBash('npm install lodash')?.label).toBe('安装新依赖')
    expect(classifyBash('npm i express')?.label).toBe('安装新依赖')
    expect(classifyBash('pip install requests')?.label).toBe('安装新依赖')
    expect(classifyBash('cd x && npm install lodash')?.label).toBe('安装新依赖')
    // 无参数 npm install（还原 lockfile）不算新依赖
    expect(classifyBash('npm install')).toBeNull()
  })

  it('引号内的关键字不误报（命令位置锚点）', () => {
    expect(classifyBash('grep -n "npm install" README.md')).toBeNull()
    expect(classifyBash('grep -q "curl" README.md && echo ok')).toBeNull()
    expect(classifyBash('cd x && curl https://example.com')?.label).toContain('网络')
  })
})

describe('parseJsonBlock JSON 提取', () => {
  it('解析标准 json 代码块', () => {
    const input = '总结如下。\n```json\n{"summary":"ok","tasks":[{"title":"t1"}]}\n```'
    expect(parseJsonBlock<{ summary: string }>(input)?.summary).toBe('ok')
  })

  it('解析裸 JSON', () => {
    expect(parseJsonBlock<{ a: number }>('{"a":1}')?.a).toBe(1)
  })

  it('解析夹杂文字的 JSON', () => {
    const input = '这是结论：{"pass": true, "summary": "全部通过"} 以上。'
    expect(parseJsonBlock<{ pass: boolean }>(input)?.pass).toBe(true)
  })

  it('无法解析时返回 null', () => {
    expect(parseJsonBlock('完全没有 JSON')).toBeNull()
  })
})

describe('质疑者 verdict 解析', () => {
  it('会议打断判断（pass / challenge）', () => {
    expect(parseJsonBlock<{ pass: boolean }>('```json\n{"pass": true}\n```')?.pass).toBe(true)
    const c = parseJsonBlock<{ pass: boolean; challenge: string }>('```json\n{"pass": false, "challenge": "为什么要引入 lodash？内置 Array 方法就够了"}\n```')
    expect(c?.pass).toBe(false)
    expect(c?.challenge).toContain('lodash')
  })

  it('评判回答（satisfied / followup）', () => {
    const s = parseJsonBlock<{ satisfied: boolean; comment?: string }>('```json\n{"satisfied": true, "comment": "已明确单进程假设"}\n```')
    expect(s?.satisfied).toBe(true)
    const f = parseJsonBlock<{ satisfied: boolean; followup?: string }>('```json\n{"satisfied": false, "followup": "那并发写入呢？"}\n```')
    expect(f?.satisfied).toBe(false)
    expect(f?.followup).toContain('并发')
  })

  it('任务挑刺 verdict（blocking / concerns）', () => {
    const v = parseJsonBlock<{ blocking: boolean; concerns: unknown[] }>(
      '放行，但有两点。\n```json\n{"blocking": false, "summary": "ok", "concerns": [{"severity": "low", "concern": "空文件名未测"}]}\n```',
    )
    expect(v?.blocking).toBe(false)
    expect(v?.concerns).toHaveLength(1)
  })
})
