import { describe, expect, it } from 'vitest'
// 纯模块（不 import db）：phaseTimeline 移植自 dogfood 交付物，metricsCalc 是指标页聚合
import { computePhases, type TimelineEvent } from '../src/lib/phaseTimeline'
import { computeGateStats, firstPassRate, wallClockSec } from '../src/lib/metricsCalc'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, created_at: string): TimelineEvent => ({
  id: ++seq,
  type,
  payload: JSON.stringify(payload),
  created_at,
})

describe('computePhases（移植内核回归）', () => {
  it('单任务正常流转产生 dev→review→qa→challenge→final 五段', () => {
    const events = [
      ev('task.created', { id: 1, title: '功能A' }, '2026-07-13 10:00:00'),
      ev('task.dev_started', { id: 1 }, '2026-07-13 10:01:00'),
      ev('task.selftest_pass', { id: 1 }, '2026-07-13 10:10:00'),
      ev('task.reviewed', { id: 1, approve: true }, '2026-07-13 10:20:00'),
      ev('task.qa', { id: 1, pass: true }, '2026-07-13 10:30:00'),
      ev('task.challenged', { id: 1, blocking: false }, '2026-07-13 10:40:00'),
      ev('task.final', { id: 1, complete: true }, '2026-07-13 10:50:00'),
      ev('task.done', { id: 1, title: '功能A' }, '2026-07-13 10:51:00'),
    ]
    const [t] = computePhases(events)
    expect(t.title).toBe('功能A')
    expect(t.reworkCount).toBe(0)
    expect(t.segments.map((s) => s.phase)).toEqual(['dev', 'review', 'qa', 'challenge', 'final'])
    expect(t.segments.every((s) => !s.open)).toBe(true)
  })

  it('审查打回产生返工计数与第二个 dev 段', () => {
    const events = [
      ev('task.dev_started', { id: 2 }, '2026-07-13 10:00:00'),
      ev('task.selftest_pass', { id: 2 }, '2026-07-13 10:05:00'),
      ev('task.reviewed', { id: 2, approve: false }, '2026-07-13 10:10:00'),
      ev('task.dev_started', { id: 2 }, '2026-07-13 10:11:00'),
      ev('task.selftest_pass', { id: 2 }, '2026-07-13 10:20:00'),
      ev('task.reviewed', { id: 2, approve: true }, '2026-07-13 10:30:00'),
    ]
    const [t] = computePhases(events)
    expect(t.reworkCount).toBe(1)
    expect(t.segments.filter((s) => s.phase === 'dev')).toHaveLength(2)
  })

  it('未闭合任务最后一段标记 open', () => {
    const events = [ev('task.dev_started', { id: 3 }, '2026-07-13 10:00:00'), ev('task.selftest_pass', { id: 3 }, '2026-07-13 10:09:00')]
    const [t] = computePhases(events)
    expect(t.segments.at(-1)!.open).toBe(true)
    expect(t.segments.at(-1)!.phase).toBe('review')
  })

  it('乱序输入按时间排序兜底；坏 payload/非 task 事件忽略；空输入回空', () => {
    const events = [
      ev('task.selftest_pass', { id: 4 }, '2026-07-13 10:05:00'),
      ev('task.dev_started', { id: 4 }, '2026-07-13 10:00:00'), // 乱序
      { id: ++seq, type: 'task.reviewed', payload: '{broken', created_at: '2026-07-13 10:06:00' },
      ev('meeting.started', { id: 99 }, '2026-07-13 10:07:00'),
    ]
    const out = computePhases(events)
    expect(out).toHaveLength(1)
    expect(out[0].segments[0].phase).toBe('dev')
    expect(computePhases([])).toEqual([])
  })
})

describe('computeGateStats（分环节拦截）', () => {
  it('五门统计 + taskIds 过滤（他项目任务不计入）', () => {
    const events = [
      ev('task.selftest_fail', { id: 10 }, '2026-07-13 10:00:00'),
      ev('task.selftest_pass', { id: 10 }, '2026-07-13 10:05:00'),
      ev('task.reviewed', { id: 10, approve: false }, '2026-07-13 10:10:00'),
      ev('task.reviewed', { id: 10, approve: true }, '2026-07-13 10:20:00'),
      ev('task.qa', { id: 10, pass: true }, '2026-07-13 10:30:00'),
      ev('task.challenged', { id: 10, blocking: true }, '2026-07-13 10:40:00'),
      ev('task.final', { id: 10, complete: false }, '2026-07-13 10:50:00'),
      ev('task.reviewed', { id: 999, approve: false }, '2026-07-13 10:55:00'), // 他项目
    ]
    const gates = Object.fromEntries(computeGateStats(events, new Set([10])).map((g) => [g.gate, g]))
    expect(gates.selftest).toMatchObject({ pass: 1, reject: 1 })
    expect(gates.review).toMatchObject({ pass: 1, reject: 1 })
    expect(gates.qa).toMatchObject({ pass: 1, reject: 0 })
    expect(gates.challenge).toMatchObject({ pass: 0, reject: 1 })
    expect(gates.final).toMatchObject({ pass: 0, reject: 1 })
  })
})

describe('firstPassRate / wallClockSec', () => {
  it('一次通过率只看 done 任务', () => {
    const r = firstPassRate([
      { status: 'done', review_cycles: 0 },
      { status: 'done', review_cycles: 2 },
      { status: 'blocked', review_cycles: 0 }, // 不计
    ])
    expect(r).toEqual({ passed: 1, total: 2 })
  })

  it('墙钟：done 用 updated_at，进行中用 now', () => {
    const done = wallClockSec({ status: 'done', created_at: '2026-07-13 10:00:00', updated_at: '2026-07-13 10:44:05' })
    expect(done).toBe(44 * 60 + 5)
    const running = wallClockSec(
      { status: 'running', created_at: '2026-07-13 10:00:00', updated_at: '2026-07-13 10:01:00' },
      '2026-07-13 10:10:00',
    )
    expect(running).toBe(600)
  })
})
