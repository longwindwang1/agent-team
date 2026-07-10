import { useState } from 'react'
import { api, useStore } from '../lib/store'
import { agentMeta, type EventRow } from '../lib/types'
import { agentLabel, useI18n } from '../lib/i18n'
import { Card, PageHeader, StatusBadge, fmtTime } from '../components/ui'

function CreateProjectForm() {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [requirement, setRequirement] = useState('')
  const [budget, setBudget] = useState('10')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { refresh } = useStore()

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, requirement, budget_usd: Number(budget) || 10 }),
      })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto max-w-2xl p-8">
      <h2 className="text-lg font-semibold text-zinc-100">{t('dash.newProject')}</h2>
      <p className="mt-1 text-sm text-zinc-500">{t('dash.newProjectDesc')}</p>
      <div className="mt-6 space-y-4">
        <div>
          <label className="mb-1.5 block text-sm text-zinc-400">{t('dash.projectName')}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('dash.projectNamePh')}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm text-zinc-400">{t('dash.requirement')}</label>
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            rows={6}
            placeholder={t('dash.requirementPh')}
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm text-zinc-400">{t('dash.budget')}</label>
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            type="number"
            min="1"
            className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
        <button
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !requirement.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t('dash.starting') : t('dash.start')}
        </button>
      </div>
    </Card>
  )
}

function EventLine({ ev }: { ev: EventRow }) {
  const { t } = useI18n()
  const meta = ev.agent_id ? agentMeta(ev.agent_id) : null
  let detail = ''
  try {
    const p = ev.payload ? (JSON.parse(ev.payload) as Record<string, unknown>) : null
    if (p) detail = (p.title as string) ?? (p.name as string) ?? (p.summary as string) ?? ''
  } catch {
    /* ignore */
  }
  return (
    <div className="flex items-baseline gap-2 py-1.5 text-sm">
      <span className="shrink-0 font-mono text-[11px] text-zinc-600">{fmtTime(ev.created_at)}</span>
      {meta && ev.agent_id && <span className={`shrink-0 text-xs font-medium ${meta.color}`}>{agentLabel(ev.agent_id, t)}</span>}
      <span className="text-zinc-400">
        <span className="font-mono text-xs text-zinc-500">{ev.type}</span>
        {detail && <span className="ml-2 text-zinc-300">{detail}</span>}
      </span>
    </div>
  )
}

export default function Dashboard() {
  const { state } = useStore()
  const { t } = useI18n()
  if (!state) return <div className="p-8 text-zinc-500">{t('dash.loading')}</div>

  const { project, agents, tasks, events, usage } = state

  if (!project) {
    return (
      <div className="p-8">
        <PageHeader title={t('nav.dashboard')} desc={t('dash.noProjectDesc')} />
        <CreateProjectForm />
      </div>
    )
  }

  const doneCount = tasks.filter((t2) => t2.status === 'done').length
  // 预算条对比的是本项目成本（此前误用全局累计成本除单项目预算——项目一多必然虚爆）
  const projectCost = usage.project?.cost_usd ?? 0
  const budgetPct = Math.min(100, (projectCost / project.budget_usd) * 100)

  const pause = () => void api(`/api/projects/${project.id}/pause`, { method: 'POST' })
  const resume = () => void api(`/api/projects/${project.id}/resume`, { method: 'POST' })

  return (
    <div className="p-8">
      <PageHeader
        title={project.name}
        desc={project.requirement.length > 120 ? project.requirement.slice(0, 120) + '…' : project.requirement}
        right={
          <div className="flex items-center gap-3">
            <StatusBadge status={project.status} />
            {project.status === 'running' ? (
              <button onClick={pause} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
                {t('dash.pause')}
              </button>
            ) : project.status === 'paused' ? (
              <button onClick={resume} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500">
                {t('dash.resume')}
              </button>
            ) : null}
          </div>
        }
      />

      {/* 统计行 */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-xs text-zinc-500">{t('dash.taskProgress')}</div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">
            {doneCount}
            <span className="text-base text-zinc-500"> / {tasks.length}</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-zinc-500">{t('dash.projectCost')}</div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">${projectCost.toFixed(2)}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div className={`h-full rounded-full ${budgetPct > 80 ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${budgetPct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-zinc-600">
            {t('dash.budgetLabel')} ${project.budget_usd.toFixed(2)} · {t('app.totalCost')} ${usage.total.cost_usd.toFixed(2)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-zinc-500">{t('dash.apiCalls')}</div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">{usage.total.calls}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-zinc-500">{t('dash.outTokens')}</div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">{(usage.total.output_tokens / 1000).toFixed(1)}k</div>
        </Card>
      </div>

      {/* Agent 团队 */}
      <h2 className="mb-3 text-sm font-medium text-zinc-400">{t('dash.team')}</h2>
      <div className="mb-6 grid grid-cols-3 gap-3">
        {agents.map((a) => {
          const meta = agentMeta(a.id)
          return (
            <Card key={a.id} className={`border p-4 ${meta.border}`}>
              <div className="flex items-center justify-between">
                <div className={`font-medium ${meta.color}`}>{agentLabel(a.id, t)}</div>
                <StatusBadge status={a.status} />
              </div>
              <div className="mt-1 text-xs text-zinc-500">{a.model}</div>
              {a.status_detail && <div className="mt-2 truncate text-xs text-zinc-400">{a.status_detail}</div>}
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* 活动流 */}
        <div>
          <h2 className="mb-3 text-sm font-medium text-zinc-400">{t('dash.activity')}</h2>
          <Card className="max-h-80 overflow-y-auto px-4 py-2">
            {events.length === 0 ? (
              <div className="py-6 text-center text-sm text-zinc-600">{t('dash.noActivity')}</div>
            ) : (
              events.map((ev) => <EventLine key={ev.id} ev={ev} />)
            )}
          </Card>
        </div>

        {/* 成本明细 */}
        <div>
          <h2 className="mb-3 text-sm font-medium text-zinc-400">{t('dash.costByRole')}</h2>
          <Card className="max-h-80 overflow-y-auto p-4">
            {usage.byAgent.length === 0 ? (
              <div className="py-6 text-center text-sm text-zinc-600">{t('dash.noCost')}</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500">
                    <th className="pb-2 font-normal">{t('dash.role')}</th>
                    <th className="pb-2 text-right font-normal">{t('dash.calls')}</th>
                    <th className="pb-2 text-right font-normal">{t('dash.outTokens')}</th>
                    <th className="pb-2 text-right font-normal">{t('dash.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...usage.byAgent]
                    .sort((a, b) => b.cost_usd - a.cost_usd)
                    .map((u) => {
                      const meta = agentMeta(u.agent_id)
                      return (
                        <tr key={u.agent_id} className="border-t border-zinc-800/60">
                          <td className={`py-1.5 ${meta.color}`}>{agentLabel(u.agent_id, t)}</td>
                          <td className="py-1.5 text-right text-zinc-400">{u.calls}</td>
                          <td className="py-1.5 text-right text-zinc-400">{(u.output_tokens / 1000).toFixed(1)}k</td>
                          <td className="py-1.5 text-right text-zinc-200">${u.cost_usd.toFixed(2)}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      {/* 项目结束后可以开下一个 */}
      {(project.status === 'done' || project.status === 'failed') && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-zinc-400">{t('dash.nextProject')}</h2>
          <CreateProjectForm />
        </div>
      )}
    </div>
  )
}
