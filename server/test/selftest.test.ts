import { describe, expect, it } from 'vitest'
import { clampOutput, runSelfTest } from '../src/lib/selftest'

describe('clampOutput（自测门输出裁剪）', () => {
  it('短输出原样合并 stdout+stderr', () => {
    expect(clampOutput('out', 'err')).toBe('out\nerr')
    expect(clampOutput('only out', '')).toBe('only out')
    expect(clampOutput('', '')).toBe('')
  })

  it('超长只保留尾部（错误信息几乎总在末尾）', () => {
    const long = 'x'.repeat(3000) + 'TAIL_ERROR'
    const r = clampOutput(long, '', 2000)
    expect(r.length).toBeLessThan(2100)
    expect(r.endsWith('TAIL_ERROR')).toBe(true)
    expect(r).toContain('省略')
  })
})

describe('runSelfTest（真实执行）', () => {
  it('命令成功 → ok=true 带输出', async () => {
    const r = await runSelfTest(process.cwd(), 'node -e "console.log(1+1)"', 30_000)
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2')
    expect(r.timedOut).toBe(false)
  })

  it('命令失败 → ok=false 带 stderr 尾部', async () => {
    const r = await runSelfTest(process.cwd(), 'node -e "console.error(\'BOOM\');process.exit(1)"', 30_000)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('BOOM')
    expect(r.timedOut).toBe(false)
  })

  it('超时 → ok=false 且 timedOut=true', async () => {
    const r = await runSelfTest(process.cwd(), 'node -e "setTimeout(()=>{}, 60000)"', 1500)
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
  }, 15_000)
})
