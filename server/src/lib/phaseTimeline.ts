/**
 * 任务阶段时间线内核：事件流 → 每任务阶段区间。
 * 移植自 v0.2 Dogfood 交付物（workspaces/project-9/repo/lib/phases.js，60 项单测验证过的状态机）。
 * 纯函数：不读库、不改入参、乱序输入按 (created_at, id) 排序兜底、坏 payload 静默忽略。
 */

export type Phase = 'dev' | 'review' | 'qa' | 'challenge' | 'final'

export interface PhaseSegment {
  phase: Phase
  start: string
  end: string
  open?: true
}

export interface TaskPhases {
  taskId: number
  title: string
  titleFallback?: true
  reworkCount: number
  segments: PhaseSegment[]
}

export interface TimelineEvent {
  id: number
  type: string
  payload: string | null
  created_at: string
}

export function parseTime(s: string): number {
  return Date.parse(s.replace(' ', 'T'))
}

interface ParsedEvent extends TimelineEvent {
  data: Record<string, unknown>
  taskId: number
}

function parseTaskEvent(e: TimelineEvent): ParsedEvent | null {
  if (!e || typeof e.type !== 'string' || !e.type.startsWith('task.')) return null
  let data: unknown = null
  if (e.payload != null) {
    try {
      data = JSON.parse(e.payload)
    } catch {
      return null
    }
  }
  if (data == null || typeof data !== 'object') return null
  const id = (data as { id?: unknown }).id
  if (typeof id !== 'number' || !Number.isFinite(id)) return null
  return { ...e, data: data as Record<string, unknown>, taskId: id }
}

const compareEvents = (a: ParsedEvent, b: ParsedEvent) => parseTime(a.created_at) - parseTime(b.created_at) || a.id - b.id

const pickTitle = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

function buildTask(taskId: number, evs: ParsedEvent[]): TaskPhases {
  let titleCreated: string | undefined
  let titleDone: string | undefined
  let reworkCount = 0
  const segments: PhaseSegment[] = []
  let openSeg: { phase: Phase; start: string } | null = null

  const closeSeg = (endTime: string) => {
    if (openSeg) {
      segments.push({ phase: openSeg.phase, start: openSeg.start, end: endTime })
      openSeg = null
    }
  }

  for (const e of evs) {
    const t = e.created_at
    const p = e.data
    switch (e.type) {
      case 'task.created':
        titleCreated = pickTitle(p.title) ?? titleCreated
        break
      case 'task.dev_started':
        closeSeg(t)
        openSeg = { phase: 'dev', start: t }
        break
      case 'task.selftest_pass':
        closeSeg(t)
        openSeg = { phase: 'review', start: t }
        break
      case 'task.selftest_fail':
        closeSeg(t)
        reworkCount++
        break
      case 'task.reviewed':
        closeSeg(t)
        if (typeof p.approve === 'boolean') {
          if (p.approve) openSeg = { phase: 'qa', start: t }
          else reworkCount++
        }
        break
      case 'task.qa':
        closeSeg(t)
        if (typeof p.pass === 'boolean') {
          if (p.pass) openSeg = { phase: 'challenge', start: t }
          else reworkCount++
        }
        break
      case 'task.challenged':
        closeSeg(t)
        if (typeof p.blocking === 'boolean') {
          if (!p.blocking) openSeg = { phase: 'final', start: t }
          else reworkCount++
        }
        break
      case 'task.final':
        closeSeg(t)
        if (typeof p.complete === 'boolean' && !p.complete) reworkCount++
        break
      case 'task.done':
        closeSeg(t)
        titleDone = pickTitle(p.title) ?? titleDone
        break
      default:
        break
    }
  }

  const lastTime = evs[evs.length - 1].created_at
  if (openSeg !== null) {
    const seg = openSeg as { phase: Phase; start: string }
    segments.push({ phase: seg.phase, start: seg.start, end: lastTime, open: true })
  }

  let title = titleCreated ?? titleDone
  let titleFallback: true | undefined
  if (title === undefined) {
    title = `task-${taskId}`
    titleFallback = true
  }
  const task: TaskPhases = { taskId, title, reworkCount, segments }
  if (titleFallback) task.titleFallback = true
  return task
}

/** 事件流 → 每任务阶段区间（按 taskId 首次出现顺序） */
export function computePhases(events: TimelineEvent[]): TaskPhases[] {
  if (!Array.isArray(events) || events.length === 0) return []
  const parsed: ParsedEvent[] = []
  for (const e of events) {
    const p = parseTaskEvent(e)
    if (p) parsed.push(p)
  }
  if (parsed.length === 0) return []
  const groups = new Map<number, ParsedEvent[]>()
  for (const e of parsed) {
    if (!groups.has(e.taskId)) groups.set(e.taskId, [])
    groups.get(e.taskId)!.push(e)
  }
  const tasks: TaskPhases[] = []
  for (const [taskId, evs] of groups) {
    tasks.push(buildTask(taskId, [...evs].sort(compareEvents)))
  }
  return tasks
}
