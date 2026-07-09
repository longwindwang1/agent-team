import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/store'
import { AGENT_META, type AgentId, type Skill } from '../lib/types'
import { agentLabel, useI18n } from '../lib/i18n'
import { Card, PageHeader } from '../components/ui'

const ALL_ROLES = Object.keys(AGENT_META) as AgentId[]
const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500'

function parseRoles(s: Skill): string[] {
  try {
    const r = JSON.parse(s.roles)
    return Array.isArray(r) ? r : ['all']
  } catch {
    return ['all']
  }
}

interface Draft {
  id?: number
  name: string
  description: string
  content: string
  roles: string[] // ['all'] 或角色 id 列表
}

const emptyDraft = (): Draft => ({ name: '', description: '', content: '', roles: ['all'] })

export default function Skills() {
  const { t } = useI18n()
  const [skills, setSkills] = useState<Skill[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSkills(await api<Skill[]>('/api/skills'))
    } catch {
      setSkills([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (s: Skill) =>
    setDraft({ id: s.id, name: s.name, description: s.description ?? '', content: s.content, roles: parseRoles(s) })

  const toggleRole = (role: string) => {
    if (!draft) return
    if (role === 'all') {
      setDraft({ ...draft, roles: ['all'] })
      return
    }
    const cur = draft.roles.filter((r) => r !== 'all')
    const next = cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]
    setDraft({ ...draft, roles: next.length === 0 ? ['all'] : next })
  }

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim() || !draft.content.trim()) {
      setErr(t('skill.needNameContent'))
      return
    }
    setBusy(true)
    setErr(null)
    const body = { name: draft.name.trim(), description: draft.description.trim(), content: draft.content.trim(), roles: draft.roles }
    try {
      if (draft.id != null) await api(`/api/skills/${draft.id}`, { method: 'PUT', body: JSON.stringify(body) })
      else await api('/api/skills', { method: 'POST', body: JSON.stringify(body) })
      setDraft(null)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (s: Skill) => {
    await api(`/api/skills/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: s.enabled === 0 }) })
    await load()
  }

  const remove = async (s: Skill) => {
    if (!window.confirm(t('skill.deleteConfirm', { name: s.name }))) return
    await api(`/api/skills/${s.id}`, { method: 'DELETE' })
    await load()
  }

  const rolesLabel = (s: Skill) => {
    const roles = parseRoles(s)
    if (roles.includes('all')) return t('skill.allRoles')
    return roles.map((r) => agentLabel(r, t)).join('、')
  }

  return (
    <div className="max-w-4xl p-8">
      <PageHeader title={t('nav.skills')} desc={t('skill.desc')} />

      <div className="mb-4">
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            + {t('skill.add')}
          </button>
        )}
      </div>

      {draft && (
        <Card className="mb-5 space-y-3 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{draft.id != null ? t('skill.editTitle') : t('skill.newTitle')}</h2>
          <input className={inputCls} placeholder={t('skill.namePh')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input
            className={inputCls}
            placeholder={t('skill.descPh')}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <textarea
            className={`${inputCls} h-40 font-mono text-xs`}
            placeholder={t('skill.contentPh')}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          <div>
            <div className="mb-1.5 text-xs text-zinc-500">{t('skill.rolesLabel')}</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => toggleRole('all')}
                className={`rounded-md border px-2.5 py-1 text-xs ${draft.roles.includes('all') ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'}`}
              >
                {t('skill.allRoles')}
              </button>
              {ALL_ROLES.map((r) => (
                <button
                  key={r}
                  onClick={() => toggleRole(r)}
                  className={`rounded-md border px-2.5 py-1 text-xs ${draft.roles.includes(r) ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'}`}
                >
                  {agentLabel(r, t)}
                </button>
              ))}
            </div>
          </div>
          {err && <p className="text-sm text-rose-400">{err}</p>}
          <div className="flex gap-2">
            <button onClick={() => void save()} disabled={busy} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-40">
              {t('skill.save')}
            </button>
            <button onClick={() => { setDraft(null); setErr(null) }} className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-zinc-500">
              {t('skill.cancel')}
            </button>
          </div>
        </Card>
      )}

      <div className="space-y-2">
        {skills.length === 0 && !draft && <div className="text-sm text-zinc-600">{t('skill.empty')}</div>}
        {skills.map((s) => (
          <Card key={s.id} className={`p-4 ${s.enabled === 0 ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100">{s.name}</span>
                  <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400">{rolesLabel(s)}</span>
                </div>
                {s.description && <div className="mt-0.5 text-xs text-zinc-500">{s.description}</div>}
                <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-600">{s.content}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-zinc-500">
                  <input type="checkbox" checked={s.enabled !== 0} onChange={() => void toggleEnabled(s)} className="accent-emerald-500" />
                  {t('skill.enabled')}
                </label>
                <button onClick={() => startEdit(s)} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500">
                  {t('skill.edit')}
                </button>
                <button onClick={() => void remove(s)} className="rounded border border-rose-800 px-2 py-0.5 text-xs text-rose-400 hover:border-rose-500">
                  {t('skill.delete')}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-zinc-600">{t('skill.applyHint')}</p>
    </div>
  )
}
