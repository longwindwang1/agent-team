// 任务依赖 DAG 的纯函数层（不 import db，可直接单测）。
// deps 列存 JSON int 数组（任务真实 id）；kickoff JSON 里的 depends_on 是同批任务的 1-based 序号。

import type { TaskRow } from '../types'

/** 安全解析 tasks.deps（脏数据一律返回 []，行为退化为无依赖） */
export function parseDeps(task: Pick<TaskRow, 'deps'>): number[] {
  try {
    const arr = JSON.parse(task.deps || '[]')
    return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/**
 * 把 kickoff JSON 的 1-based 序号映射为真实任务 id。
 * ordinalToId 的下标含被跳过的无效项（跳过项值为 null）——序号基于原数组，防错位。
 * 越界/自引用/NaN/指向被跳过项 → 丢弃并记入 invalid。
 */
export function mapOrdinalsToIds(
  dependsOn: unknown,
  selfOrdinal: number,
  ordinalToId: Array<number | null>,
): { ids: number[]; invalid: unknown[] } {
  const ids: number[] = []
  const invalid: unknown[] = []
  if (!Array.isArray(dependsOn)) return { ids, invalid }
  for (const raw of dependsOn) {
    const ord = Number(raw) // 容忍 "1" 这类字符串数字
    if (!Number.isInteger(ord) || ord < 1 || ord > ordinalToId.length || ord === selfOrdinal) {
      invalid.push(raw)
      continue
    }
    const id = ordinalToId[ord - 1]
    if (id == null) {
      invalid.push(raw)
      continue
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids, invalid }
}

/** Kahn 拓扑排序找环：返回环内任务 id 集合（空集 = 无环） */
export function findCycleIds(tasks: Array<Pick<TaskRow, 'id' | 'deps'>>): Set<number> {
  const idSet = new Set(tasks.map((t) => t.id))
  const indegree = new Map<number, number>()
  const dependents = new Map<number, number[]>() // dep -> 依赖它的任务
  for (const t of tasks) {
    const deps = parseDeps(t).filter((d) => idSet.has(d))
    indegree.set(t.id, deps.length)
    for (const d of deps) {
      const list = dependents.get(d) ?? []
      list.push(t.id)
      dependents.set(d, list)
    }
  }
  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id)
  const removed = new Set<number>()
  while (queue.length > 0) {
    const id = queue.shift()!
    removed.add(id)
    for (const dep of dependents.get(id) ?? []) {
      const n = (indegree.get(dep) ?? 0) - 1
      indegree.set(dep, n)
      if (n === 0) queue.push(dep)
    }
  }
  return new Set(tasks.filter((t) => !removed.has(t.id)).map((t) => t.id))
}

/**
 * 依赖是否全部满足（调度门控）。
 * dep done → 满足（含强制通过：代码已在 main）；本任务或 dep 在环内 → 忽略该边（破环防死锁）；
 * dep 不在本项目快照 → 防御式放行；其余状态 → 未满足。
 */
export function depsSatisfied(
  task: Pick<TaskRow, 'id' | 'deps'>,
  byId: Map<number, Pick<TaskRow, 'id' | 'status'>>,
  cycleIds: Set<number>,
): boolean {
  if (cycleIds.has(task.id)) return true
  for (const depId of parseDeps(task)) {
    if (cycleIds.has(depId)) continue
    const dep = byId.get(depId)
    if (!dep) continue // 快照里不存在：防御式放行（调用方可记警告）
    if (dep.status !== 'done') return false
  }
  return true
}

/** 安全解析 tasks.owns_files */
export function parseOwnsFiles(task: Pick<TaskRow, 'owns_files'>): string[] {
  try {
    const arr = JSON.parse(task.owns_files || '[]')
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()) : []
  } catch {
    return []
  }
}
