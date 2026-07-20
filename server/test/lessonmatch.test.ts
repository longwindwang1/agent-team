import { describe, expect, it } from 'vitest'
// 纯模块（不 import db）：移植自 Dogfood 项目 #14 交付物的 10 项验收测试（AC5-AC14），
// 断言逐条对应 workspaces/project-14/repo/lessonMatch.test.js——移植后内核行为不得漂移
import { matchLessons } from '../src/lib/lessonMatch'

describe('lessonMatch 内核（移植回归）', () => {
  it('AC5 纯中文匹配：共享中文 bigram 被召回，why 含中文关键词', () => {
    const lessons = [
      { id: 'zh1', tags: '', content: '任务超时导致失败，需要增加重试机制' },
      { id: 'zh2', tags: '', content: '数据库连接池耗尽引发雪崩' },
    ]
    const result = matchLessons(lessons, '本次上线又遇到超时问题', 10)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('zh1')
    expect(result[0].score).toBeGreaterThan(0)
    expect(result[0].why).toContain('超时')
  })

  it('AC6 纯英文匹配：why 为小写，单字符词不成词元', () => {
    const result = matchLessons(
      [
        { id: 'en1', tags: '', content: 'connection TIMEOUT error after retry' },
        { id: 'en2', tags: '', content: 'unrelated content about caching' },
      ],
      'production TIMEOUT occurred again',
      10,
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('en1')
    expect(result[0].why).toContain('timeout')
    expect(result[0].why).not.toContain('TIMEOUT')

    const short = matchLessons(
      [
        { id: 'short1', tags: '', content: 'ab' },
        { id: 'short2', tags: '', content: 'a' },
      ],
      'ab a i',
      10,
    )
    expect(short).toHaveLength(1)
    expect(short[0].id).toBe('short1')
    expect(matchLessons([{ id: 'single', tags: '', content: 'i a' }], 'i a', 10)).toEqual([])
  })

  it('AC7 中英混合命中的 score 高于任一单侧命中', () => {
    const result = matchLessons(
      [
        { id: 'mixed', tags: '', content: '超时 timeout 问题记录' },
        { id: 'zhOnly', tags: '', content: '超时 现象说明' },
        { id: 'enOnly', tags: '', content: 'timeout notes' },
      ],
      '超时 timeout',
      10,
    )
    const byId = Object.fromEntries(result.map((r) => [r.id, r.score]))
    expect(byId.mixed).toBeGreaterThan(byId.zhOnly)
    expect(byId.mixed).toBeGreaterThan(byId.enOnly)
  })

  it('AC8 idf：罕见词的隔离贡献大于常见词', () => {
    const result = matchLessons(
      [
        { id: 'onlyA', tags: '', content: 'alpha' },
        { id: 'onlyB', tags: '', content: 'beta' },
        { id: 'fillerA1', tags: '', content: 'alpha' },
        { id: 'fillerA2', tags: '', content: 'alpha' },
        { id: 'fillerA3', tags: '', content: 'alpha' },
      ],
      'alpha beta',
      10,
    )
    const byId = Object.fromEntries(result.map((r) => [r.id, r.score]))
    expect(byId.onlyA).toBeGreaterThan(0)
    expect(byId.onlyB).toBeGreaterThan(byId.onlyA)
  })

  it('AC9 tags ×2 改变排序，score_甲 ≈ score_乙 × 2', () => {
    const sharedContent = '这是一段共享的说明文字 keyword 相关'
    const result = matchLessons(
      [
        { id: '乙', tags: '其他标签', content: sharedContent },
        { id: '甲', tags: 'keyword', content: sharedContent },
      ],
      'keyword',
      10,
    )
    expect(result.map((r) => r.id)).toEqual(['甲', '乙'])
    expect(Math.abs(result[0].score - result[1].score * 2)).toBeLessThan(1e-9)
  })

  it('AC10 字符集不重叠返回 []', () => {
    expect(matchLessons([{ id: 'en', tags: '', content: 'apple banana orange' }], '苹果香蕉橙子', 10)).toEqual([])
  })

  it('AC11 topK 截断取分数最高的前 K 条', () => {
    const lessons = [
      { id: 'l1', tags: '', content: 'one two three four five' },
      { id: 'l2', tags: '', content: 'one two three four' },
      { id: 'l3', tags: '', content: 'one two three' },
      { id: 'l4', tags: '', content: 'one two' },
      { id: 'l5', tags: '', content: 'one' },
    ]
    const full = matchLessons(lessons, 'one two three four five', 10)
    expect(full.map((r) => r.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
    const truncated = matchLessons(lessons, 'one two three four five', 2)
    expect(truncated.map((r) => r.id)).toEqual(['l1', 'l2'])
  })

  it('AC12/13 空库、空/纯空白/纯标点简报均返回 []', () => {
    expect(matchLessons([], '任意简报内容 timeout', 3)).toEqual([])
    const lessons = [{ id: 'l1', tags: '', content: '超时 timeout error' }]
    expect(matchLessons(lessons, '', 3)).toEqual([])
    expect(matchLessons(lessons, '   \t\n  ', 3)).toEqual([])
    expect(matchLessons(lessons, '。,，！!!!...---', 3)).toEqual([])
  })

  it('AC14 why 上限 5 且元素唯一', () => {
    const result = matchLessons(
      [{ id: 'many', tags: '', content: 'alpha beta gamma delta epsilon zeta eta' }],
      'alpha beta gamma delta epsilon zeta eta',
      10,
    )
    expect(result).toHaveLength(1)
    expect(result[0].why).toHaveLength(5)
    expect(new Set(result[0].why).size).toBe(5)
  })
})
