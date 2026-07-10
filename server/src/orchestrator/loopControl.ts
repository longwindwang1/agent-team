/**
 * Loop 工程的循环出口判定：全部纯函数（不 import db），可直接单测。
 * 统一哲学：verdict 解析失败一律 fail-open（放行）——坏模型退化为无循环的旧行为，而非把流程卡进死循环。
 */

export interface ConvergenceVerdict {
  satisfied: boolean
  objections: string[]
}

/** 质疑者会议收敛裁决归一化；解析失败/空 → 满意（fail-open，同 challengeCheckpoint 哲学） */
export function normalizeConvergence(v: unknown): ConvergenceVerdict {
  if (!v || typeof v !== 'object') return { satisfied: true, objections: [] }
  const o = v as { satisfied?: unknown; objections?: unknown }
  if (o.satisfied !== false) return { satisfied: true, objections: [] }
  const objections = Array.isArray(o.objections)
    ? o.objections.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : []
  // 声称不满意但一条异议都说不出来 → 视为满意（不给下一轮任何可执行输入的"不满意"没有意义）
  if (objections.length === 0) return { satisfied: true, objections: [] }
  return { satisfied: false, objections }
}

export type MeetingRoundNext = 'converged' | 'deadlock' | 'cap' | 'continue'

/**
 * kickoff 每轮结束后的走向：
 * - satisfied === true → converged（质疑者无异议，提前散会）
 * - satisfied === null（质疑者不可用）→ 只剩 deadlock/cap 两个出口 = 今天的行为
 * - 全员 PASS（spokeCount=0）→ deadlock：再开一轮也没人说话，异议转交总结裁决
 * - 到达上限 → cap：带着异议进总结
 */
export function nextMeetingRound(p: { satisfied: boolean | null; spokeCount: number; round: number; maxRounds: number }): MeetingRoundNext {
  if (p.satisfied === true) return 'converged'
  if (p.spokeCount === 0) return 'deadlock'
  if (p.round >= p.maxRounds) return 'cap'
  return 'continue'
}

export type DesignLoopNext = 'pass' | 'revise' | 'cap'

/** 设计环走向：pass 判定沿用现有语义（pass !== false 或无 issues 即放行，fail-open） */
export function designLoopNext(p: { pass: boolean | null; issueCount: number; cycle: number; maxCycles: number }): DesignLoopNext {
  if (p.pass !== false || p.issueCount === 0) return 'pass'
  if (p.cycle >= p.maxCycles) return 'cap'
  return 'revise'
}

export interface FinalVerdict {
  complete: boolean
  gaps: Array<{ gap: string; suggestion?: string }>
}

/** 协调者终审裁决归一化；解析失败 → complete（fail-open：precedent 是 challengePhase 解析失败即放行合并） */
export function normalizeFinalVerdict(v: unknown): FinalVerdict {
  if (!v || typeof v !== 'object') return { complete: true, gaps: [] }
  const o = v as { complete?: unknown; gaps?: unknown }
  if (o.complete !== false) return { complete: true, gaps: [] }
  const gaps = Array.isArray(o.gaps)
    ? o.gaps
        .filter((g): g is { gap?: unknown; suggestion?: unknown } => !!g && typeof g === 'object')
        .filter((g) => typeof g.gap === 'string' && !!(g.gap as string).trim())
        .map((g) => ({
          gap: (g.gap as string).trim(),
          ...(typeof g.suggestion === 'string' && (g.suggestion as string).trim() ? { suggestion: (g.suggestion as string).trim() } : {}),
        }))
    : []
  // 声称未完成但说不出缺口 → 视为完成（无可执行输入的否决没有意义）
  if (gaps.length === 0) return { complete: true, gaps: [] }
  return { complete: false, gaps }
}
