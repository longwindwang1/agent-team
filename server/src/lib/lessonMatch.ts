/**
 * 中英双语教训检索内核（纯函数，不 import db）。
 * 移植自平台 Dogfood 项目 #14 的交付物（workspaces/project-14/repo/lessonMatch.js，
 * 10 项验收测试全绿）——与 phaseTimeline.ts 同一条"平台产出反哺平台"路径。
 *
 * 切词：中文连续汉字二字组（重叠滑窗，孤立单字不成词）+ 英文/数字小写词（长度≥2），混合文本两套规则各切后合并。
 * 打分：presence×idf 的 tf-idf 风格——idf = ln(1 + N/df)，罕见词权重高；词元命中 tags 时贡献 ×2；
 *       同一词元一条内只计一次；why 为命中词元按贡献降序去重取前 5。
 */

export interface MatchableLesson {
  id: number | string
  tags?: string | null
  content?: string | null
}

export interface MatchResult {
  id: number | string
  score: number
  why: string[]
}

const CJK_RUN_RE = /[一-鿿]+/g
const WORD_RE = /[a-z0-9]+/g

/** 切词：中文 bigram + 英文/数字小写词（≥2）；结果可含重复，调用方自行去重 */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return []
  const tokens: string[] = []
  const cjkRuns = text.match(CJK_RUN_RE)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2))
    }
  }
  const words = text.toLowerCase().match(WORD_RE)
  if (words) {
    for (const w of words) {
      if (w.length >= 2) tokens.push(w)
    }
  }
  return tokens
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return []
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** 文档频率：每条教训取 (content ∪ tags) 的词元 Set 全库累加 */
export function buildDf(lessons: MatchableLesson[]): { df: Map<string, number>; N: number } {
  const df = new Map<string, number>()
  for (const lesson of lessons) {
    const termSet = new Set([...tokenize(lesson.content), ...parseTags(lesson.tags).flatMap((t) => tokenize(t))])
    for (const term of termSet) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { df, N: lessons.length }
}

/** idf = ln(1 + N/df)：罕见词更高权且非负 */
export function idf(dfCount: number, N: number): number {
  if (dfCount <= 0) return 0
  return Math.log(1 + N / dfCount)
}

/** 给定教训库与简报文本，返回按相关度降序的 top-K（score>0 才返回；同分按输入顺序稳定） */
export function matchLessons(lessons: MatchableLesson[], briefText: string, topK = 3): MatchResult[] {
  if (!Array.isArray(lessons) || lessons.length === 0) return []
  const { df, N } = buildDf(lessons)
  const briefSet = new Set(tokenize(briefText))
  if (briefSet.size === 0) return []

  const results: Array<MatchResult & { _index: number }> = []
  lessons.forEach((lesson, index) => {
    const tagTokens = parseTags(lesson.tags).flatMap((t) => tokenize(t))
    const lessonSet = new Set([...tokenize(lesson.content), ...tagTokens])
    const tagsSet = new Set(tagTokens)

    let score = 0
    const contributions: Array<{ term: string; weight: number }> = []
    for (const term of briefSet) {
      if (!lessonSet.has(term)) continue
      const weight = idf(df.get(term) ?? 0, N) * (tagsSet.has(term) ? 2 : 1)
      score += weight
      contributions.push({ term, weight })
    }

    if (score > 0) {
      contributions.sort((a, b) => b.weight - a.weight)
      const why: string[] = []
      const seen = new Set<string>()
      for (const { term } of contributions) {
        if (seen.has(term)) continue
        seen.add(term)
        why.push(term)
        if (why.length >= 5) break
      }
      results.push({ id: lesson.id, score, why, _index: index })
    }
  })

  results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a._index - b._index))
  return results.slice(0, topK).map(({ id, score, why }) => ({ id, score, why }))
}
