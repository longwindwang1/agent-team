import { describe, expect, it } from 'vitest'
// loopControl.ts 是纯函数模块（不 import db），可直接引入
import { designLoopNext, nextMeetingRound, normalizeConvergence, normalizeFinalVerdict } from '../src/orchestrator/loopControl'
import { parseJsonBlock } from '../src/lib/json'

describe('normalizeConvergence（会议收敛裁决归一化）', () => {
  it('满意 → 直接满意', () => {
    expect(normalizeConvergence({ satisfied: true })).toEqual({ satisfied: true, objections: [] })
  })

  it('不满意 + 异议清单 → 保留裁剪后的异议', () => {
    const r = normalizeConvergence({ satisfied: false, objections: [' 边界未定 ', '验收标准缺失'] })
    expect(r).toEqual({ satisfied: false, objections: ['边界未定', '验收标准缺失'] })
  })

  it('解析失败/空 → fail-open 满意', () => {
    expect(normalizeConvergence(null).satisfied).toBe(true)
    expect(normalizeConvergence(undefined).satisfied).toBe(true)
    expect(normalizeConvergence('not json').satisfied).toBe(true)
  })

  it('不满意但异议为空/非数组/全空串 → 视为满意（无可执行输入）', () => {
    expect(normalizeConvergence({ satisfied: false }).satisfied).toBe(true)
    expect(normalizeConvergence({ satisfied: false, objections: 'x' }).satisfied).toBe(true)
    expect(normalizeConvergence({ satisfied: false, objections: ['', '  ', 42] }).satisfied).toBe(true)
  })

  it('非字符串项被过滤，字符串项保留', () => {
    const r = normalizeConvergence({ satisfied: false, objections: [1, '有效异议', null] })
    expect(r.objections).toEqual(['有效异议'])
  })
})

describe('nextMeetingRound（kickoff 轮次走向）', () => {
  it('质疑者满意 → 第 1 轮即可收敛散会', () => {
    expect(nextMeetingRound({ satisfied: true, spokeCount: 3, round: 1, maxRounds: 4 })).toBe('converged')
  })

  it('不满意且有人发言且未达上限 → 继续下一轮', () => {
    expect(nextMeetingRound({ satisfied: false, spokeCount: 2, round: 2, maxRounds: 4 })).toBe('continue')
  })

  it('round === maxRounds 边界 → cap', () => {
    expect(nextMeetingRound({ satisfied: false, spokeCount: 2, round: 4, maxRounds: 4 })).toBe('cap')
  })

  it('全员 PASS 但仍不满意 → deadlock（再开轮也没人说话）', () => {
    expect(nextMeetingRound({ satisfied: false, spokeCount: 0, round: 2, maxRounds: 4 })).toBe('deadlock')
  })

  it('质疑者不可用（satisfied=null）→ 只剩 deadlock/cap = 今天的行为', () => {
    expect(nextMeetingRound({ satisfied: null, spokeCount: 0, round: 1, maxRounds: 4 })).toBe('deadlock')
    expect(nextMeetingRound({ satisfied: null, spokeCount: 2, round: 4, maxRounds: 4 })).toBe('cap')
    expect(nextMeetingRound({ satisfied: null, spokeCount: 2, round: 1, maxRounds: 4 })).toBe('continue')
  })

  it('converged 优先于 deadlock/cap（同轮满足多个条件时）', () => {
    expect(nextMeetingRound({ satisfied: true, spokeCount: 0, round: 4, maxRounds: 4 })).toBe('converged')
  })
})

describe('designLoopNext（设计环走向）', () => {
  it('第 1 轮 pass → pass', () => {
    expect(designLoopNext({ pass: true, issueCount: 0, cycle: 1, maxCycles: 3 })).toBe('pass')
  })

  it('pass:false 但 issues 空 → pass（沿用现有 fail-open 语义）', () => {
    expect(designLoopNext({ pass: false, issueCount: 0, cycle: 1, maxCycles: 3 })).toBe('pass')
  })

  it('解析失败（pass=null）→ pass（fail-open）', () => {
    expect(designLoopNext({ pass: null, issueCount: 2, cycle: 1, maxCycles: 3 })).toBe('pass')
  })

  it('中途有 issues → revise', () => {
    expect(designLoopNext({ pass: false, issueCount: 2, cycle: 2, maxCycles: 3 })).toBe('revise')
  })

  it('cycle === maxCycles 边界 → cap', () => {
    expect(designLoopNext({ pass: false, issueCount: 1, cycle: 3, maxCycles: 3 })).toBe('cap')
  })

  it('maxCycles=1 → 首轮不过即 cap（等价于旧的单轮行为+告警）', () => {
    expect(designLoopNext({ pass: false, issueCount: 1, cycle: 1, maxCycles: 1 })).toBe('cap')
  })
})

describe('normalizeFinalVerdict（终审裁决归一化）', () => {
  it('complete:true → 完成', () => {
    expect(normalizeFinalVerdict({ complete: true })).toEqual({ complete: true, gaps: [] })
  })

  it('complete:false + gaps → 保留缺口（suggestion 可选）', () => {
    const r = normalizeFinalVerdict({ complete: false, gaps: [{ gap: '缺验收项 3', suggestion: '补 done 命令' }, { gap: '无 README' }] })
    expect(r.complete).toBe(false)
    expect(r.gaps).toEqual([{ gap: '缺验收项 3', suggestion: '补 done 命令' }, { gap: '无 README' }])
  })

  it('解析失败 → fail-open 完成', () => {
    expect(normalizeFinalVerdict(null).complete).toBe(true)
    expect(normalizeFinalVerdict('oops').complete).toBe(true)
  })

  it('complete:false 但 gaps 空/畸形 → 视为完成（无可执行输入）', () => {
    expect(normalizeFinalVerdict({ complete: false }).complete).toBe(true)
    expect(normalizeFinalVerdict({ complete: false, gaps: [{ suggestion: '只有建议没有缺口' }, 'str', null] }).complete).toBe(true)
  })

  it('gaps 形状钳制：空串 suggestion 被丢弃、gap 去空白', () => {
    const r = normalizeFinalVerdict({ complete: false, gaps: [{ gap: ' 缺口 ', suggestion: '  ' }] })
    expect(r.gaps).toEqual([{ gap: '缺口' }])
  })
})

describe('loop verdict JSON 经 parseJsonBlock 解析（含散文包裹）', () => {
  it('收敛裁决', () => {
    const reply = '我认为还没收敛。\n```json\n{"satisfied": false, "objections": ["任务 2 的边界与任务 3 重叠"]}\n```'
    const v = normalizeConvergence(parseJsonBlock(reply))
    expect(v.satisfied).toBe(false)
    expect(v.objections).toHaveLength(1)
  })

  it('设计复审裁决', () => {
    const reply = '复查完毕：\n```json\n{"pass": false, "issues": [{"concern": "缓存失效策略缺失", "suggestion": "加 TTL"}]}\n```'
    const parsed = parseJsonBlock<{ pass?: boolean; issues?: Array<{ concern: string }> }>(reply)
    expect(designLoopNext({ pass: parsed?.pass ?? null, issueCount: parsed?.issues?.length ?? 0, cycle: 1, maxCycles: 3 })).toBe('revise')
  })

  it('终审裁决（无代码块围栏的裸 JSON 也可解析）', () => {
    const v = normalizeFinalVerdict(parseJsonBlock('{"complete": false, "gaps": [{"gap": "验收标准 2 未覆盖"}]}'))
    expect(v.complete).toBe(false)
  })
})
