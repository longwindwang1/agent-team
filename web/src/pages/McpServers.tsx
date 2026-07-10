import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/store'
import { AGENT_META, type AgentId, type McpServer } from '../lib/types'
import { agentLabel, useI18n } from '../lib/i18n'
import { Card, PageHeader } from '../components/ui'

const ALL_ROLES = Object.keys(AGENT_META) as AgentId[]
const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500'
type Transport = 'stdio' | 'sse' | 'http'
interface KV { key: string; value: string }

interface Draft {
  id?: number
  name: string
  description: string
  transport: Transport
  command: string
  argsText: string // 每行一个参数
  env: KV[]
  url: string
  headers: KV[]
  roles: string[]
}

const emptyDraft = (): Draft => ({
  id: undefined,
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  env: [],
  url: '',
  headers: [],
  roles: ['all'],
})

const toKV = (rec: Record<string, string>): KV[] => Object.entries(rec).map(([key, value]) => ({ key, value }))
const fromKV = (kv: KV[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const { key, value } of kv) {
    const k = key.trim()
    if (k) out[k] = value
  }
  return out
}

function KVEditor({ rows, onChange, keyPh, valuePh, addLabel }: {
  rows: KV[]
  onChange: (rows: KV[]) => void
  keyPh: string
  valuePh: string
  addLabel: string
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className={`${inputCls} flex-1`}
            placeholder={keyPh}
            value={row.key}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
          />
          <input
            className={`${inputCls} flex-1 font-mono`}
            placeholder={valuePh}
            value={row.value}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <button
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="rounded border border-zinc-700 px-2 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-400"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="rounded border border-dashed border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-zinc-500"
      >
        + {addLabel}
      </button>
    </div>
  )
}

export default function McpServers() {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServer[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setServers(await api<McpServer[]>('/api/mcp-servers'))
    } catch {
      setServers([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (s: McpServer) =>
    setDraft({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      transport: s.transport,
      command: s.command ?? '',
      argsText: (s.args ?? []).join('\n'),
      env: toKV(s.env ?? {}),
      url: s.url ?? '',
      headers: toKV(s.headers ?? {}),
      roles: s.roles?.length ? s.roles : ['all'],
    })

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
    if (!draft.name.trim()) {
      setErr(t('mcp.needName'))
      return
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      setErr(t('mcp.needCommand'))
      return
    }
    if (draft.transport !== 'stdio' && !draft.url.trim()) {
      setErr(t('mcp.needUrl'))
      return
    }
    const isRemote = draft.transport !== 'stdio'
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      transport: draft.transport,
      command: isRemote ? null : draft.command.trim(),
      args: isRemote ? [] : draft.argsText.split('\n').map((s) => s.trim()).filter(Boolean),
      env: isRemote ? {} : fromKV(draft.env),
      url: isRemote ? draft.url.trim() : null,
      headers: isRemote ? fromKV(draft.headers) : {},
      roles: draft.roles,
    }
    setBusy(true)
    setErr(null)
    try {
      if (draft.id != null) await api(`/api/mcp-servers/${draft.id}`, { method: 'PUT', body: JSON.stringify(body) })
      else await api('/api/mcp-servers', { method: 'POST', body: JSON.stringify(body) })
      setDraft(null)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (s: McpServer) => {
    await api(`/api/mcp-servers/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: s.enabled === 0 }) })
    await load()
  }

  const remove = async (s: McpServer) => {
    if (!window.confirm(t('mcp.deleteConfirm', { name: s.name }))) return
    await api(`/api/mcp-servers/${s.id}`, { method: 'DELETE' })
    await load()
  }

  const rolesLabel = (s: McpServer) => {
    if (!s.roles?.length || s.roles.includes('all')) return t('mcp.allRoles')
    return s.roles.map((r) => agentLabel(r, t)).join('、')
  }

  const summary = (s: McpServer) =>
    s.transport === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : s.url ?? ''

  return (
    <div className="max-w-4xl p-8">
      <PageHeader title={t('nav.mcp')} desc={t('mcp.desc')} />

      <div className="mb-4">
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            + {t('mcp.add')}
          </button>
        )}
      </div>

      {draft && (
        <Card className="mb-5 space-y-3 p-5">
          <h2 className="text-sm font-semibold text-zinc-200">{draft.id != null ? t('mcp.editTitle') : t('mcp.newTitle')}</h2>
          <input className={inputCls} placeholder={t('mcp.namePh')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <p className="-mt-1.5 text-[11px] text-zinc-600">{t('mcp.nameHint')}</p>
          <input
            className={inputCls}
            placeholder={t('mcp.descPh')}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />

          <div>
            <div className="mb-1.5 text-xs text-zinc-500">{t('mcp.transport')}</div>
            <div className="flex gap-2">
              {(['stdio', 'sse', 'http'] as Transport[]).map((tr) => (
                <button
                  key={tr}
                  onClick={() => setDraft({ ...draft, transport: tr })}
                  className={`rounded-md border px-3 py-1 text-xs ${draft.transport === tr ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'}`}
                >
                  {tr}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">{t('mcp.transportHint')}</p>
          </div>

          {draft.transport === 'stdio' ? (
            <>
              <div>
                <div className="mb-1 text-xs text-zinc-500">{t('mcp.command')}</div>
                <input className={`${inputCls} font-mono`} placeholder={t('mcp.commandPh')} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              </div>
              <div>
                <div className="mb-1 text-xs text-zinc-500">{t('mcp.args')}</div>
                <textarea className={`${inputCls} h-20 font-mono text-xs`} placeholder={t('mcp.argsPh')} value={draft.argsText} onChange={(e) => setDraft({ ...draft, argsText: e.target.value })} />
              </div>
              <div>
                <div className="mb-1 text-xs text-zinc-500">{t('mcp.env')}</div>
                <KVEditor rows={draft.env} onChange={(env) => setDraft({ ...draft, env })} keyPh={t('mcp.kvKeyPh')} valuePh={t('mcp.kvValuePh')} addLabel={t('mcp.addRow')} />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="mb-1 text-xs text-zinc-500">{t('mcp.url')}</div>
                <input className={`${inputCls} font-mono`} placeholder={t('mcp.urlPh')} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              </div>
              <div>
                <div className="mb-1 text-xs text-zinc-500">{t('mcp.headers')}</div>
                <KVEditor rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} keyPh={t('mcp.kvKeyPh')} valuePh={t('mcp.kvValuePh')} addLabel={t('mcp.addRow')} />
              </div>
            </>
          )}
          <p className="text-[11px] text-zinc-600">{t('mcp.secretHint')}</p>

          <div>
            <div className="mb-1.5 text-xs text-zinc-500">{t('mcp.rolesLabel')}</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => toggleRole('all')}
                className={`rounded-md border px-2.5 py-1 text-xs ${draft.roles.includes('all') ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'}`}
              >
                {t('mcp.allRoles')}
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
              {t('mcp.save')}
            </button>
            <button onClick={() => { setDraft(null); setErr(null) }} className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-zinc-500">
              {t('mcp.cancel')}
            </button>
          </div>
        </Card>
      )}

      <div className="space-y-2">
        {servers.length === 0 && !draft && <div className="text-sm text-zinc-600">{t('mcp.empty')}</div>}
        {servers.map((s) => (
          <Card key={s.id} className={`p-4 ${s.enabled === 0 ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100">{s.name}</span>
                  <span className="rounded bg-sky-700/40 px-1.5 py-0.5 text-[10px] text-sky-300">{s.transport}</span>
                  <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400">{rolesLabel(s)}</span>
                </div>
                {s.description && <div className="mt-0.5 text-xs text-zinc-500">{s.description}</div>}
                <div className="mt-1.5 truncate font-mono text-xs text-zinc-600">{summary(s)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1 text-[11px] text-zinc-500">
                  <input type="checkbox" checked={s.enabled !== 0} onChange={() => void toggleEnabled(s)} className="accent-emerald-500" />
                  {t('mcp.enabled')}
                </label>
                <button onClick={() => startEdit(s)} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500">
                  {t('mcp.edit')}
                </button>
                <button onClick={() => void remove(s)} className="rounded border border-rose-800 px-2 py-0.5 text-xs text-rose-400 hover:border-rose-500">
                  {t('mcp.delete')}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-zinc-600">{t('mcp.applyHint')}</p>
    </div>
  )
}
