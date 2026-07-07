import { addLesson, listLessons } from '../db/dao'
import type { AgentPool } from './agentPool'
import type { LessonRow, ProjectRow, TaskRow } from '../types'
import { logEvent } from '../events'
import { roleEnabled } from '../settings'
import { parseJsonBlock } from './meetingRunner'
import { tx } from './texts'

/**
 * 团队记忆：自动归档（零 LLM）+ 书记官低频提炼 + 精准注入。
 * 设计原则：会议记录/决议已在 SQLite 里，不用 LLM 复述；只有"提炼坑"值得花模型调用。
 */

/** 从文本提取匹配关键词：拉丁词（≥3 字符）+ 中文 2-gram，最多 12 个 */
export function extractKeywords(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  const cjkRuns = text.match(/[一-鿿]{2,}/g) ?? []
  const bigrams: string[] = []
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length && bigrams.length < 20; i++) bigrams.push(run.slice(i, i + 2))
  }
  return [...new Set([...latin, ...bigrams])].slice(0, 12)
}

/** 按关键词相关度挑 lessons（置顶恒选，其余按命中数+新近度） */
export function rankLessons(lessons: LessonRow[], queryText: string, limit: number): LessonRow[] {
  const keywords = extractKeywords(queryText)
  const scored = lessons.map((l) => {
    const hay = `${l.tags ?? ''} ${l.content}`.toLowerCase()
    const hits = keywords.filter((k) => hay.includes(k)).length
    return { l, score: (l.pinned ? 1000 : 0) + hits * 10 + l.id / 1e6 }
  })
  return scored
    .filter((s) => s.l.pinned || s.score >= 10) // 非置顶至少命中一个关键词
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.l)
}

/** 归档一条原始记录（返工意见/质疑/裁决/用户批示），零 LLM 成本 */
export function archiveLesson(input: {
  project_id?: number | null
  source_type: LessonRow['source_type']
  source_id?: number | null
  tags?: string
  content: string
  created_by?: string
}): void {
  if (!input.content?.trim()) return
  addLesson({ ...input, content: input.content.trim().slice(0, 2000) })
  logEvent('lesson.recorded', input.created_by ?? 'system', { source: input.source_type, id: input.source_id })
}

/** 给任务简报注入相关团队记忆（提炼过的 retro/manual 优先，不注入 raw 归档） */
export function lessonsForBrief(projectId: number, queryText: string, limit = 5): string {
  const pool = listLessons({ projectId, limit: 200 }).filter((l) => l.source_type === 'retro' || l.source_type === 'manual')
  const picked = rankLessons(pool, queryText, limit)
  if (picked.length === 0) return ''
  const items = picked.map((l) => `- ${l.content}`).join('\n')
  return tx().lessonsSection(items)
}

/** kickoff 用：全局（跨项目）记忆 */
export function globalLessonsSection(limit = 5): string {
  const globals = listLessons({ limit: 100 }).filter((l) => l.project_id == null && (l.source_type === 'retro' || l.source_type === 'manual'))
  if (globals.length === 0) return ''
  const items = globals.slice(0, limit).map((l) => `- ${l.content}`).join('\n')
  return tx().lessonsSection(items)
}

/** 该任务的 raw 归档记录（供提炼输入） */
function rawHistoryForTask(projectId: number, taskId: number): string {
  return listLessons({ projectId, limit: 200 })
    .filter((l) => l.source_type === 'task' && l.source_id === taskId)
    .map((l) => `- [${l.created_by}] ${l.content}`)
    .join('\n')
}

/** 任务终结且经历过返工 → 书记官提炼 1-3 条教训（一次低价模型调用，异步不阻塞流程） */
export function distillTask(pool: AgentPool, task: TaskRow): void {
  if (!roleEnabled('scribe')) return
  const history = [rawHistoryForTask(task.project_id, task.id), task.review_notes ? `- ${task.review_notes}` : '']
    .filter(Boolean)
    .join('\n')
  if (!history.trim()) return
  void pool
    .ask('scribe', tx().scribeDistillTask({ id: task.id, title: task.title, history: history.slice(0, 6000) }), {
      statusDetail: tx().stDistill,
      timeoutMs: 5 * 60_000,
    })
    .then((reply) => {
      const parsed = parseJsonBlock<{ lessons?: Array<{ tags?: string; content: string }> }>(reply)
      for (const l of (parsed?.lessons ?? []).slice(0, 3)) {
        if (!l.content?.trim()) continue
        addLesson({ project_id: task.project_id, source_type: 'retro', source_id: task.id, tags: l.tags, content: l.content.trim(), created_by: 'scribe' })
      }
      logEvent('lesson.distilled', 'scribe', { task: task.id, count: parsed?.lessons?.length ?? 0 })
    })
    .catch(() => {})
}

/** 项目交付 → 书记官提炼跨项目教训（全局记忆） */
export async function distillProject(pool: AgentPool, project: ProjectRow): Promise<void> {
  if (!roleEnabled('scribe')) return
  const history = listLessons({ projectId: project.id, limit: 300 })
    .filter((l) => l.project_id === project.id)
    .map((l) => `- [${l.source_type}/${l.created_by}] ${l.content}`)
    .join('\n')
  if (!history.trim()) return
  try {
    const reply = await pool.ask(
      'scribe',
      tx().scribeDistillProject({ name: project.name, requirement: project.requirement, history: history.slice(0, 8000) }),
      { statusDetail: tx().stDistill, timeoutMs: 5 * 60_000 },
    )
    const parsed = parseJsonBlock<{ lessons?: Array<{ tags?: string; content: string }> }>(reply)
    for (const l of (parsed?.lessons ?? []).slice(0, 3)) {
      if (!l.content?.trim()) continue
      addLesson({ project_id: null, source_type: 'retro', source_id: project.id, tags: l.tags, content: l.content.trim(), created_by: 'scribe' })
    }
    logEvent('lesson.distilled', 'scribe', { project: project.id, count: parsed?.lessons?.length ?? 0 })
  } catch {
    /* 提炼失败不影响交付 */
  }
}
