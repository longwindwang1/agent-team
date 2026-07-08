import { describe, expect, it } from 'vitest'
// lib/deps.ts 不 import db，可直接引入
import { depsSatisfied, findCycleIds, mapOrdinalsToIds, parseDeps, parseOwnsFiles } from '../src/lib/deps'

const task = (id: number, deps: number[], status = 'assigned') => ({ id, deps: JSON.stringify(deps), status })

describe('parseDeps / parseOwnsFiles 脏数据容错', () => {
  it('正常/空/脏数据', () => {
    expect(parseDeps({ deps: '[1,2]' })).toEqual([1, 2])
    expect(parseDeps({ deps: '[]' })).toEqual([])
    expect(parseDeps({ deps: '' })).toEqual([])
    expect(parseDeps({ deps: 'not json' })).toEqual([])
    expect(parseDeps({ deps: '["a", 3, -1, 2.5]' })).toEqual([3]) // 非正整数丢弃
    expect(parseOwnsFiles({ owns_files: '["a.js", "", 42]' })).toEqual(['a.js'])
    expect(parseOwnsFiles({ owns_files: 'oops' })).toEqual([])
  })
})

describe('mapOrdinalsToIds 序号映射', () => {
  // 原数组 4 项：第 2 项无 title 被跳过（占号但值 null）
  const ordinalToId: Array<number | null> = [101, null, 103, 104]

  it('正常映射（含字符串数字容忍）', () => {
    const { ids, invalid } = mapOrdinalsToIds([1, '3'], 4, ordinalToId)
    expect(ids).toEqual([101, 103])
    expect(invalid).toEqual([])
  })

  it('跳过项错位用例：引用被跳过的序号 → invalid', () => {
    const { ids, invalid } = mapOrdinalsToIds([2], 4, ordinalToId)
    expect(ids).toEqual([])
    expect(invalid).toEqual([2])
  })

  it('越界/自引用/NaN → invalid', () => {
    const { ids, invalid } = mapOrdinalsToIds([0, 5, 3, 'x', null], 3, ordinalToId)
    expect(ids).toEqual([]) // 3 是自引用（selfOrdinal=3）
    expect(invalid).toEqual([0, 5, 3, 'x', null])
  })

  it('非数组输入安全返回', () => {
    expect(mapOrdinalsToIds('nope', 1, ordinalToId).ids).toEqual([])
    expect(mapOrdinalsToIds(undefined, 1, ordinalToId).ids).toEqual([])
  })

  it('去重', () => {
    expect(mapOrdinalsToIds([1, 1, '1'], 4, ordinalToId).ids).toEqual([101])
  })
})

describe('findCycleIds 环检测（Kahn）', () => {
  it('无环', () => {
    expect(findCycleIds([task(1, []), task(2, [1]), task(3, [1, 2])]).size).toBe(0)
  })

  it('自环', () => {
    expect([...findCycleIds([task(1, [1]), task(2, [])])]).toEqual([1])
  })

  it('二元环', () => {
    const cyc = findCycleIds([task(1, [2]), task(2, [1]), task(3, [])])
    expect([...cyc].sort()).toEqual([1, 2])
  })

  it('大环 + 挂在环上的下游也算环内（无法完成）', () => {
    const cyc = findCycleIds([task(1, [3]), task(2, [1]), task(3, [2]), task(4, [1]), task(5, [])])
    expect([...cyc].sort()).toEqual([1, 2, 3, 4])
  })

  it('指向不存在任务的边忽略', () => {
    expect(findCycleIds([task(1, [999]), task(2, [1])]).size).toBe(0)
  })
})

describe('depsSatisfied 调度门控', () => {
  const byId = new Map([
    [1, { id: 1, status: 'done' }],
    [2, { id: 2, status: 'in_progress' }],
    [3, { id: 3, status: 'blocked' }],
  ])
  const noCycles = new Set<number>()

  it('依赖全 done → 放行', () => {
    expect(depsSatisfied(task(10, [1]), byId, noCycles)).toBe(true)
    expect(depsSatisfied(task(10, []), byId, noCycles)).toBe(true)
  })

  it('依赖进行中/阻塞 → 等待', () => {
    expect(depsSatisfied(task(10, [1, 2]), byId, noCycles)).toBe(false)
    expect(depsSatisfied(task(10, [3]), byId, noCycles)).toBe(false)
  })

  it('依赖不在快照 → 防御式放行', () => {
    expect(depsSatisfied(task(10, [999]), byId, noCycles)).toBe(true)
  })

  it('本任务在环内 → 放行（破环）；依赖在环内 → 忽略该边', () => {
    expect(depsSatisfied(task(10, [2]), byId, new Set([10]))).toBe(true)
    expect(depsSatisfied(task(10, [2]), byId, new Set([2]))).toBe(true)
  })
})
