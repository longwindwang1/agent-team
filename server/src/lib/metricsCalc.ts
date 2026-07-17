/** 指标页纯聚合（不 import db，可单测）：分环节拦截统计 + 一次通过率 */

import type { TimelineEvent } from './phaseTimeline'

export type GateId = 'selftest' | 'review' | 'qa' | 'challenge' | 'final' | 'integration'

export interface GateStat {
  gate: GateId
  pass: number
  reject: number
}

/** 从 task.* 事件流统计各质检门的通过/拦截次数（只计 taskIds 内的任务） */
export function computeGateStats(events: TimelineEvent[], taskIds: Set<number>): GateStat[] {
  const stats: Record<GateId, { pass: number; reject: number }> = {
    selftest: { pass: 0, reject: 0 },
    review: { pass: 0, reject: 0 },
    qa: { pass: 0, reject: 0 },
    challenge: { pass: 0, reject: 0 },
    final: { pass: 0, reject: 0 },
    integration: { pass: 0, reject: 0 },
  }
  for (const e of events) {
    if (!e.type.startsWith('task.')) continue
    let p: Record<string, unknown>
    try {
      p = JSON.parse(e.payload ?? '{}') as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof p.id !== 'number' || !taskIds.has(p.id)) continue
    switch (e.type) {
      case 'task.selftest_pass':
        stats.selftest.pass++
        break
      case 'task.selftest_fail':
        stats.selftest.reject++
        break
      case 'task.reviewed':
        if (typeof p.approve === 'boolean') stats.review[p.approve ? 'pass' : 'reject']++
        break
      case 'task.qa':
        if (typeof p.pass === 'boolean') stats.qa[p.pass ? 'pass' : 'reject']++
        break
      case 'task.challenged':
        if (typeof p.blocking === 'boolean') stats.challenge[p.blocking ? 'reject' : 'pass']++
        break
      case 'task.final':
        if (typeof p.complete === 'boolean') stats.final[p.complete ? 'pass' : 'reject']++
        break
      case 'task.integration_pass':
        stats.integration.pass++
        break
      case 'task.integration_fail':
        stats.integration.reject++
        break
    }
  }
  return (Object.keys(stats) as GateId[]).map((gate) => ({ gate, ...stats[gate] }))
}

/** 一次通过率：done 任务里 review_cycles===0 的比例 */
export function firstPassRate(tasks: Array<{ status: string; review_cycles: number }>): { passed: number; total: number } {
  const done = tasks.filter((t) => t.status === 'done')
  return { passed: done.filter((t) => t.review_cycles === 0).length, total: done.length }
}

/** 墙钟秒数：created_at → done 用 updated_at，未结束用 now */
export function wallClockSec(project: { status: string; created_at: string; updated_at: string }, nowIso?: string): number {
  const start = Date.parse(project.created_at.replace(' ', 'T'))
  const endStr = project.status === 'done' || project.status === 'failed' ? project.updated_at : (nowIso ?? new Date().toISOString())
  const end = Date.parse(endStr.replace(' ', 'T'))
  return Math.max(0, Math.round((end - start) / 1000))
}
