import { useEffect, useState } from 'react'
import { api, useStore } from '../lib/store'
import { AGENT_META, type AgentId } from '../lib/types'
import { agentLabel, useI18n, type Lang } from '../lib/i18n'
import { Card, PageHeader } from '../components/ui'

const MODEL_OPTIONS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm text-zinc-300">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-600">{hint}</p>}
    </div>
  )
}

const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500'

export default function Settings() {
  const { state, refresh } = useStore()
  const { t, lang, setLang } = useI18n()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (state?.settings) setForm(state.settings)
  }, [state?.settings])

  const set = (k: string, v: string) => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async () => {
    setBusy(true)
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(form) })
      await refresh()
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-3xl p-8">
      <PageHeader title={t('nav.settings')} desc={t('set.desc')} />

      <div className="space-y-6">
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.language')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('set.uiLang')}>
              <select className={inputCls} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </Field>
            <Field label={t('set.teamLang')} hint={t('set.teamLangHint')}>
              <select className={inputCls} value={form.team_language ?? 'zh'} onChange={(e) => set('team_language', e.target.value)}>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.reporting')}</h2>
          <Field label={t('set.cron')} hint={t('set.cronHint')}>
            <input className={inputCls} value={form.report_cron ?? ''} onChange={(e) => set('report_cron', e.target.value)} />
          </Field>
          <Field label={t('set.testMode')} hint={t('set.testModeHint')}>
            <select className={inputCls} value={form.report_test_mode ?? 'off'} onChange={(e) => set('report_test_mode', e.target.value)}>
              <option value="off">{t('set.testOff')}</option>
              <option value="fast">{t('set.testOn')}</option>
            </select>
          </Field>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.budgetSec')}</h2>
          <div className="grid grid-cols-3 gap-4">
            <Field label={t('set.budget')} hint={t('set.budgetHint')}>
              <input className={inputCls} type="number" min="1" value={form.budget_usd ?? ''} onChange={(e) => set('budget_usd', e.target.value)} />
            </Field>
            <Field label={t('set.rounds')} hint={t('set.roundsHint')}>
              <input
                className={inputCls}
                type="number"
                min="1"
                max="5"
                value={form.meeting_max_rounds ?? ''}
                onChange={(e) => set('meeting_max_rounds', e.target.value)}
              />
            </Field>
            <Field label={t('set.cycles')} hint={t('set.cyclesHint')}>
              <input
                className={inputCls}
                type="number"
                min="1"
                max="10"
                value={form.max_review_cycles ?? ''}
                onChange={(e) => set('max_review_cycles', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.models')}</h2>
          <div className="grid grid-cols-2 gap-4">
            {(Object.keys(AGENT_META) as AgentId[]).map((id) => (
              <Field key={id} label={agentLabel(id, t)}>
                <select className={inputCls} value={form[`model.${id}`] ?? 'claude-opus-4-8'} onChange={(e) => set(`model.${id}`, e.target.value)}>
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <p className="text-xs text-zinc-600">{t('set.modelsHint')}</p>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-orange-400">{t('set.challengerSec')}</h2>
          <div className="grid grid-cols-2 gap-4">
            {(
              [
                { key: 'challenge_meeting', label: 'set.chMeeting', hint: 'set.chMeetingHint' },
                { key: 'challenge_design', label: 'set.chDesign', hint: 'set.chDesignHint' },
                { key: 'challenge_tasks', label: 'set.chTasks', hint: 'set.chTasksHint' },
                { key: 'challenge_approvals', label: 'set.chApprovals', hint: 'set.chApprovalsHint' },
              ] as const
            ).map((item) => (
              <Field key={item.key} label={t(item.label)} hint={t(item.hint)}>
                <select className={inputCls} value={form[item.key] ?? 'on'} onChange={(e) => set(item.key, e.target.value)}>
                  <option value="on">{t('set.on')}</option>
                  <option value="off">{t('set.off')}</option>
                </select>
              </Field>
            ))}
            <Field label={t('set.chFollowups')} hint={t('set.chFollowupsHint')}>
              <input
                className={inputCls}
                type="number"
                min="0"
                max="5"
                value={form.challenge_max_followups ?? ''}
                onChange={(e) => set('challenge_max_followups', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? t('set.saving') : t('set.save')}
          </button>
          {saved && <span className="text-sm text-emerald-400">{t('set.saved')}</span>}
        </div>
      </div>
    </div>
  )
}
