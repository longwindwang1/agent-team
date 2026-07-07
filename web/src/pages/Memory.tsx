import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/store'
import { agentLabel, useI18n } from '../lib/i18n'
import type { Lesson } from '../lib/types'
import { Card, PageHeader, fmtTime } from '../components/ui'

const SOURCE_STYLE: Record<string, string> = {
  retro: 'bg-emerald-400/10 text-emerald-300',
  manual: 'bg-sky-400/10 text-sky-300',
  task: 'bg-zinc-500/10 text-zinc-400',
  meeting: 'bg-violet-400/10 text-violet-300',
  approval: 'bg-amber-400/10 text-amber-300',
}

export default function Memory() {
  const { t } = useI18n()
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [q, setQ] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [global, setGlobal] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const rows = await api<Lesson[]>(`/api/lessons${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    setLessons(rows)
  }, [q])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!content.trim()) return
    setBusy(true)
    try {
      await api('/api/lessons', { method: 'POST', body: JSON.stringify({ content, tags: tags || undefined, global }) })
      setContent('')
      setTags('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const pin = async (l: Lesson) => {
    await api(`/api/lessons/${l.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !l.pinned }) })
    await load()
  }

  const remove = async (l: Lesson) => {
    await api(`/api/lessons/${l.id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="max-w-4xl p-8">
      <PageHeader title={t('nav.memory')} desc={t('mem.desc')} />

      {/* 手动添加 */}
      <Card className="mb-6 space-y-3 p-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          placeholder={t('mem.addPh')}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
        />
        <div className="flex items-center gap-3">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('mem.tagsPh')}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-zinc-400">
            <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} className="accent-emerald-500" />
            {t('mem.global')}
          </label>
          <button
            onClick={() => void add()}
            disabled={busy || !content.trim()}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {t('mem.submit')}
          </button>
        </div>
      </Card>

      {/* 搜索 */}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('mem.searchPh')}
        className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />

      {/* 列表 */}
      {lessons.length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-600">{t('mem.empty')}</Card>
      ) : (
        <div className="space-y-2">
          {lessons.map((l) => (
            <Card key={l.id} className={`p-3 ${l.pinned ? 'border-amber-400/40' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
                    {l.pinned ? '📌 ' : ''}
                    {l.content}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={`rounded px-1.5 py-0.5 ${SOURCE_STYLE[l.source_type] ?? SOURCE_STYLE.task}`}>{l.source_type}</span>
                    {l.project_id == null && <span className="rounded bg-indigo-400/10 px-1.5 py-0.5 text-indigo-300">{t('mem.globalTag')}</span>}
                    <span className="text-zinc-500">{agentLabel(l.created_by, t)}</span>
                    {l.tags && <span className="text-zinc-600">{l.tags}</span>}
                    <span className="font-mono text-zinc-600">{fmtTime(l.created_at)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => void pin(l)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800">
                    {l.pinned ? t('mem.unpin') : t('mem.pin')}
                  </button>
                  <button
                    onClick={() => void remove(l)}
                    className="rounded border border-rose-500/40 px-2 py-0.5 text-[11px] text-rose-400 hover:bg-rose-500/10"
                  >
                    {t('mem.delete')}
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
