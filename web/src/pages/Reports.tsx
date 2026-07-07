import { useState } from 'react'
import { marked } from 'marked'
import { api, useStore } from '../lib/store'
import { useI18n } from '../lib/i18n'
import { Card, PageHeader, fmtTime } from '../components/ui'

export default function Reports() {
  const { state, refresh } = useStore()
  const { t } = useI18n()
  const reports = state?.reports ?? []
  const [busy, setBusy] = useState(false)

  const generateNow = async () => {
    setBusy(true)
    try {
      await api('/api/reports/generate', { method: 'POST' })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-8">
      <PageHeader
        title={t('nav.reports')}
        desc={t('rep.desc')}
        right={
          <button
            onClick={() => void generateNow()}
            disabled={busy || !state?.project}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {busy ? t('rep.generating') : t('rep.generate')}
          </button>
        }
      />

      {reports.length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-600">{t('rep.empty')}</Card>
      ) : (
        <div className="space-y-6">
          {reports.map((r) => (
            <Card key={r.id} className="p-6">
              <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
                <div className="text-sm font-medium text-zinc-300">{t('rep.reportN', { id: r.id })}</div>
                <div className="font-mono text-xs text-zinc-500">{fmtTime(r.created_at)}</div>
              </div>
              <div
                className="text-sm leading-relaxed text-zinc-300 [&_a]:text-sky-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-zinc-200 [&_li]:my-0.5 [&_p]:my-2 [&_strong]:text-zinc-100 [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-800 [&_th]:bg-zinc-800/50 [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                dangerouslySetInnerHTML={{ __html: marked.parse(r.markdown, { async: false }) }}
              />
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
