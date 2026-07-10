import { useCallback, useEffect, useState } from 'react'
import { api, useStore } from '../lib/store'
import { AGENT_META, type AgentId, type BalanceEntry, type ProviderInfo, type ProviderPreset } from '../lib/types'
import { agentLabel, useI18n, type Lang } from '../lib/i18n'
import { Card, PageHeader } from '../components/ui'

const MODEL_OPTIONS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']
/** 可开关的角色（协调者与前后端开发常驻） */
const TOGGLABLE_ROLES: AgentId[] = ['ba', 'architect', 'devops', 'reviewer', 'qa', 'challenger', 'scribe']
/** 依赖严格 JSON 协议的角色：选第三方模型时给出警示 */
const JSON_CRITICAL_ROLES: AgentId[] = ['architect', 'ba', 'reviewer', 'qa', 'challenger']

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

interface ProviderEditForm {
  id: string
  name: string
  base_url: string
  api_key: string
  small_fast_model: string
  balance_adapter: string
  recharge_url: string
  modelsText: string
  isNew: boolean
}

function emptyEditForm(): ProviderEditForm {
  return { id: '', name: '', base_url: '', api_key: '', small_fast_model: '', balance_adapter: 'none', recharge_url: '', modelsText: '[]', isNew: true }
}

/** 模型提供商管理卡片 + 各 provider 余额/充值入口。providers 走独立接口（不进 /api/state，缩小 key 暴露面） */
function ProvidersCard({ providers, reload }: { providers: ProviderInfo[]; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [balances, setBalances] = useState<Record<string, { entries: BalanceEntry[] | null; error?: string; loading?: boolean }>>({})
  const [edit, setEdit] = useState<ProviderEditForm | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const loadBalance = useCallback((id: string, force = false) => {
    setBalances((b) => ({ ...b, [id]: { ...(b[id] ?? { entries: null }), loading: true } }))
    void api<{ balance: BalanceEntry[] | null; error?: string }>(`/api/providers/${id}/balance${force ? '?force=1' : ''}`)
      .then((r) => setBalances((b) => ({ ...b, [id]: { entries: r.balance, error: r.error } })))
      .catch((e: Error) => setBalances((b) => ({ ...b, [id]: { entries: null, error: e.message } })))
  }, [])

  useEffect(() => {
    void api<ProviderPreset[]>('/api/providers/presets').then(setPresets).catch(() => {})
  }, [])

  // 首次拿到 provider 列表时自动查一轮余额（60s 服务端缓存兜底，不怕重复触发）
  useEffect(() => {
    for (const p of providers) {
      if (p.balance_adapter !== 'none' && p.has_key && !balances[p.id]) loadBalance(p.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, loadBalance])

  const startFromPreset = (preset: ProviderPreset) => {
    setErr(null)
    setEdit({
      id: preset.id,
      name: preset.name,
      base_url: preset.base_url,
      api_key: '',
      small_fast_model: preset.small_fast_model ?? '',
      balance_adapter: preset.balance_adapter,
      recharge_url: preset.recharge_url,
      modelsText: JSON.stringify(preset.models, null, 2),
      isNew: !providers.some((p) => p.id === preset.id),
    })
  }

  const startEdit = (p: ProviderInfo) => {
    setErr(null)
    setEdit({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      api_key: '', // 不回显；留空保留原 key
      small_fast_model: p.small_fast_model ?? '',
      balance_adapter: p.balance_adapter,
      recharge_url: p.recharge_url ?? '',
      modelsText: JSON.stringify(p.models, null, 2),
      isNew: false,
    })
  }

  const saveEdit = async () => {
    if (!edit) return
    setErr(null)
    let models: unknown
    try {
      models = JSON.parse(edit.modelsText)
      if (!Array.isArray(models) || models.some((m) => !m || typeof (m as { id?: unknown }).id !== 'string')) throw new Error()
    } catch {
      setErr(t('set.providerModelsBad'))
      return
    }
    const body = {
      id: edit.id.trim(),
      name: edit.name.trim(),
      base_url: edit.base_url.trim(),
      ...(edit.api_key.trim() ? { api_key: edit.api_key.trim() } : {}),
      small_fast_model: edit.small_fast_model.trim() || null,
      balance_adapter: edit.balance_adapter,
      recharge_url: edit.recharge_url.trim() || null,
      models,
    }
    try {
      if (edit.isNew) await api('/api/providers', { method: 'POST', body: JSON.stringify(body) })
      else await api(`/api/providers/${edit.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setEdit(null)
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const remove = async (p: ProviderInfo) => {
    if (!window.confirm(t('set.providerDeleteConfirm', { name: p.name }))) return
    await api(`/api/providers/${p.id}`, { method: 'DELETE' })
    await reload()
  }

  const fmtBalance = (p: ProviderInfo): string => {
    if (p.balance_adapter === 'none') return t('set.providerNoBalance')
    const b = balances[p.id]
    if (!b || b.loading) return '…'
    if (!b.entries || b.entries.length === 0) return b.error ? `— (${b.error})` : '—'
    return b.entries.map((e) => `${e.currency} ${e.amount.toFixed(2)}`).join(' / ')
  }

  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-sm font-semibold text-zinc-200">{t('set.providersSec')}</h2>
      <p className="text-xs text-zinc-600">{t('set.providersHint')}</p>

      {providers.length > 0 && (
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="rounded-md border border-zinc-800 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium text-zinc-200">{p.name}</span>
                <span className="font-mono text-xs text-zinc-500">{p.id}</span>
                <span className="text-xs text-zinc-500">{t('set.providerModelsCount', { n: p.models.length })}</span>
                <span className={`text-xs ${p.has_key ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {p.has_key ? t('set.providerKeySet', { tail: p.key_tail }) : t('set.providerNoKey')}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-zinc-400" title={balances[p.id]?.error ?? ''}>
                    {t('set.providerBalance')}: <span className="font-mono text-zinc-200">{fmtBalance(p)}</span>
                  </span>
                  {p.balance_adapter !== 'none' && p.has_key && (
                    <button
                      onClick={() => loadBalance(p.id, true)}
                      className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500"
                      title={t('set.providerRefresh')}
                    >
                      ↻
                    </button>
                  )}
                  {p.recharge_url && (
                    <a
                      href={p.recharge_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-emerald-700 px-2 py-0.5 text-xs text-emerald-400 hover:border-emerald-500"
                    >
                      {t('set.providerRecharge')} ↗
                    </a>
                  )}
                  <button onClick={() => startEdit(p)} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500">
                    {t('set.providerEdit')}
                  </button>
                  <button onClick={() => void remove(p)} className="rounded border border-rose-800 px-2 py-0.5 text-xs text-rose-400 hover:border-rose-500">
                    {t('set.providerDelete')}
                  </button>
                </span>
              </div>
              <div className="mt-1 font-mono text-xs text-zinc-600">{p.base_url}</div>
            </div>
          ))}
        </div>
      )}

      {!edit && (
        <div className="flex items-center gap-2">
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            value=""
            onChange={(e) => {
              const preset = presets.find((x) => x.id === e.target.value)
              if (preset) startFromPreset(preset)
              else if (e.target.value === '__custom') setEdit(emptyEditForm())
            }}
          >
            <option value="" disabled>
              {t('set.providerAdd')}
            </option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.note ? `（${p.note}）` : ''}
              </option>
            ))}
            <option value="__custom">{t('set.providerCustom')}</option>
          </select>
        </div>
      )}

      {edit && (
        <div className="space-y-3 rounded-md border border-zinc-700 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('set.providerId')} hint={t('set.providerIdHint')}>
              <input className={inputCls} value={edit.id} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
            </Field>
            <Field label={t('set.providerName')}>
              <input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label={t('set.providerBaseUrl')}>
              <input className={inputCls} value={edit.base_url} onChange={(e) => setEdit({ ...edit, base_url: e.target.value })} />
            </Field>
            <Field label={t('set.providerKey')} hint={edit.isNew ? undefined : t('set.providerKeyKeepHint')}>
              <input
                className={inputCls}
                type="password"
                autoComplete="off"
                placeholder={edit.isNew ? '' : '••••••••'}
                value={edit.api_key}
                onChange={(e) => setEdit({ ...edit, api_key: e.target.value })}
              />
            </Field>
            <Field label={t('set.providerSmallFast')} hint={t('set.providerSmallFastHint')}>
              <input className={inputCls} value={edit.small_fast_model} onChange={(e) => setEdit({ ...edit, small_fast_model: e.target.value })} />
            </Field>
            <Field label={t('set.providerRechargeUrl')}>
              <input className={inputCls} value={edit.recharge_url} onChange={(e) => setEdit({ ...edit, recharge_url: e.target.value })} />
            </Field>
          </div>
          <Field label={t('set.providerModels')} hint={t('set.providerModelsHint')}>
            <textarea
              className={`${inputCls} h-40 font-mono text-xs`}
              value={edit.modelsText}
              onChange={(e) => setEdit({ ...edit, modelsText: e.target.value })}
            />
          </Field>
          {err && <p className="text-sm text-rose-400">{err}</p>}
          <div className="flex gap-2">
            <button onClick={() => void saveEdit()} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500">
              {t('set.providerSave')}
            </button>
            <button onClick={() => setEdit(null)} className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-zinc-500">
              {t('set.providerCancel')}
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

export default function Settings() {
  const { state, refresh } = useStore()
  const { t, lang, setLang } = useI18n()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [provList, setProvList] = useState<ProviderInfo[]>([])

  const loadProviders = useCallback(async () => {
    try {
      setProvList(await api<ProviderInfo[]>('/api/providers'))
      await refresh() // 删除 provider 会在服务端重置引用它的 model.* 设置
    } catch {
      // server 未起时静默
    }
  }, [refresh])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

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
          <Field label={t('set.approvalPolicy')} hint={t('set.approvalPolicyHint')}>
            <select className={inputCls} value={form.approval_policy ?? 'budget_only'} onChange={(e) => set('approval_policy', e.target.value)}>
              <option value="budget_only">{t('set.approvalBudgetOnly')}</option>
              <option value="all">{t('set.approvalAll')}</option>
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label={t('set.budget')} hint={t('set.budgetHint')}>
              <input className={inputCls} type="number" min="1" value={form.budget_usd ?? ''} onChange={(e) => set('budget_usd', e.target.value)} />
            </Field>
            <Field label={t('set.rounds')} hint={t('set.roundsHint')}>
              <input
                className={inputCls}
                type="number"
                min="1"
                max="8"
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
          <Field label={t('set.finalReview')} hint={t('set.finalReviewHint')}>
            <select className={inputCls} value={form.final_review ?? 'on'} onChange={(e) => set('final_review', e.target.value)}>
              <option value="on">{t('set.on')}</option>
              <option value="off">{t('set.off')}</option>
            </select>
          </Field>
          <Field label={t('set.recycle')} hint={t('set.recycleHint')}>
            <select className={inputCls} value={form.session_recycle ?? 'project_end'} onChange={(e) => set('session_recycle', e.target.value)}>
              <option value="project_end">{t('set.recycleProjectEnd')}</option>
              <option value="on">{t('set.recyclePerTask')}</option>
              <option value="off">{t('set.recycleOff')}</option>
            </select>
          </Field>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.rolesSec')}</h2>
          <p className="text-xs text-zinc-600">{t('set.rolesHint')}</p>
          <div className="grid grid-cols-4 gap-3">
            {TOGGLABLE_ROLES.map((id) => (
              <label key={id} className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm hover:border-zinc-600">
                <span className={AGENT_META[id].color}>{agentLabel(id, t)}</span>
                <input
                  type="checkbox"
                  checked={(form[`role_enabled.${id}`] ?? 'on') !== 'off'}
                  onChange={(e) => set(`role_enabled.${id}`, e.target.checked ? 'on' : 'off')}
                  className="accent-emerald-500"
                />
              </label>
            ))}
          </div>
        </Card>

        <ProvidersCard providers={provList} reload={loadProviders} />

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{t('set.models')}</h2>
          <div className="grid grid-cols-2 gap-4">
            {(Object.keys(AGENT_META) as AgentId[]).map((id) => {
              const value = form[`model.${id}`] ?? 'claude-opus-4-8'
              const isThirdParty = value.includes('/')
              const known = MODEL_OPTIONS.includes(value) || provList.some((p) => p.models.some((m) => `${p.id}/${m.id}` === value))
              return (
                <Field key={id} label={agentLabel(id, t)}>
                  <div className="flex gap-2">
                    <select className={inputCls} value={value} onChange={(e) => set(`model.${id}`, e.target.value)}>
                      {/* 当前值不在任何选项中（如 provider 已删）时给 disabled 兜底，防 select 静默跳值 */}
                      {!known && (
                        <option value={value} disabled>
                          {value} (?)
                        </option>
                      )}
                      <optgroup label="Anthropic">
                        {MODEL_OPTIONS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </optgroup>
                      {provList.map((p) => (
                        <optgroup key={p.id} label={p.name}>
                          {p.models.map((m) => (
                            <option key={m.id} value={`${p.id}/${m.id}`}>
                              {m.label ?? m.id}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <select
                      className="w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                      value={form[`effort.${id}`] ?? 'medium'}
                      onChange={(e) => set(`effort.${id}`, e.target.value)}
                      title={t('set.effort')}
                    >
                      {EFFORT_OPTIONS.map((ef) => (
                        <option key={ef} value={ef}>
                          {ef}
                        </option>
                      ))}
                    </select>
                  </div>
                  {isThirdParty && id === 'coordinator' && <p className="mt-1 text-xs text-rose-400">{t('set.coordThirdWarn')}</p>}
                  {isThirdParty && JSON_CRITICAL_ROLES.includes(id) && <p className="mt-1 text-xs text-amber-400">{t('set.thirdPartyJsonWarn')}</p>}
                </Field>
              )
            })}
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
            <Field label={t('set.chDesignCycles')} hint={t('set.chDesignCyclesHint')}>
              <input
                className={inputCls}
                type="number"
                min="1"
                max="6"
                value={form.design_max_cycles ?? ''}
                onChange={(e) => set('design_max_cycles', e.target.value)}
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
