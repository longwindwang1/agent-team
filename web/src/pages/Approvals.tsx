import { useState } from 'react'
import { api, useStore } from '../lib/store'
import { agentMeta, type Approval } from '../lib/types'
import { agentLabel, useI18n } from '../lib/i18n'
import { Card, PageHeader, StatusBadge, fmtTime } from '../components/ui'

function PendingCard({ approval }: { approval: Approval }) {
  const { refresh } = useStore()
  const { t } = useI18n()
  const [comment, setComment] = useState('')
  const [choice, setChoice] = useState<string | null>(approval.recommendation)
  const [busy, setBusy] = useState(false)
  const options: string[] = approval.options ? (JSON.parse(approval.options) as string[]) : []

  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      await api(`/api/approvals/${approval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approve, decision: approve ? (choice ?? undefined) : undefined, comment: comment || undefined }),
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-amber-400/30 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-medium text-zinc-100">{approval.title}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {t('appr.requestedBy', { who: agentLabel(approval.requested_by, t), time: fmtTime(approval.created_at) })}
          </div>
        </div>
        <StatusBadge status="pending" />
      </div>

      {approval.context && (
        <div className="mt-3 whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-sm leading-relaxed text-zinc-300">
          {approval.context}
        </div>
      )}

      {options.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {options.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm hover:border-zinc-600"
            >
              <input type="radio" name={`opt-${approval.id}`} checked={choice === opt} onChange={() => setChoice(opt)} className="accent-emerald-500" />
              <span className="text-zinc-200">{opt}</span>
              {approval.recommendation === opt && <span className="ml-auto text-[11px] text-amber-400">{t('appr.recommended')}</span>}
            </label>
          ))}
        </div>
      )}

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('appr.commentPh')}
        rows={2}
        className="mt-3 w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void decide(true)}
          disabled={busy || (options.length > 0 && !choice)}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {t('appr.approve')}
        </button>
        <button
          onClick={() => void decide(false)}
          disabled={busy}
          className="rounded-md border border-rose-500/50 px-4 py-2 text-sm font-medium text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
        >
          {t('appr.reject')}
        </button>
      </div>
    </Card>
  )
}

export default function Approvals() {
  const { state } = useStore()
  const { t } = useI18n()
  const approvals = state?.approvals ?? []
  const pending = approvals.filter((a) => a.status === 'pending')
  const history = approvals.filter((a) => a.status !== 'pending')

  return (
    <div className="p-8">
      <PageHeader title={t('nav.approvals')} desc={t('appr.desc')} />

      {pending.length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-600">{t('appr.none')}</Card>
      ) : (
        <div className="space-y-4">
          {pending.map((a) => (
            <PendingCard key={a.id} approval={a} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-medium text-zinc-400">{t('appr.history')}</h2>
          <div className="space-y-2">
            {history.map((a) => {
              const meta = agentMeta(a.requested_by)
              return (
                <Card key={a.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-sm text-zinc-200">{a.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      <span className={meta.color}>{agentLabel(a.requested_by, t)}</span> · {fmtTime(a.created_at)}
                      {a.decision && <span className="ml-2 text-zinc-400">{t('appr.choice', { v: a.decision })}</span>}
                      {a.comment && <span className="ml-2 text-zinc-400">{t('appr.comment', { v: a.comment })}</span>}
                    </div>
                  </div>
                  <StatusBadge status={a.status} />
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
