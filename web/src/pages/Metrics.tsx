import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/store'
import type { Project, UsageSummary } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { Card, PageHeader, StatusBadge } from '../components/ui'

type Phase = 'dev' | 'review' | 'qa' | 'challenge' | 'final'

interface PhaseSegment {
  phase: Phase
  start: string
  end: string
  open?: true
}

interface MetricsResp {
  project: { id: number; name: string; status: string; budget_usd: number }
  wall_clock_sec: number
  usage: UsageSummary
  tasks_total: number
  tasks_done: number
  first_pass: { passed: number; total: number }
  gates: Array<{ gate: 'selftest' | 'review' | 'qa' | 'challenge' | 'final' | 'integration'; pass: number; reject: number }>
  interventions: { approvals: number; auto_approved: number; user_chats: number }
  phases: Array<{ taskId: number; title: string; reworkCount: number; segments: PhaseSegment[] }>
}

const PHASE_COLOR: Record<Phase, string> = {
  dev: '#10b981', // emerald
  review: '#8b5cf6', // violet
  qa: '#06b6d4', // cyan
  challenge: '#f97316', // orange
  final: '#f59e0b', // amber
}

const parseT = (s: string) => Date.parse(s.replace(' ', 'T'))

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ''}`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

/** SVG 泳道图：每任务一行，阶段色块按真实时间比例排布（布局思路移植自 dogfood 交付物） */
function TimelineSvg({ phases, phaseLabel }: { phases: MetricsResp['phases']; phaseLabel: (p: Phase) => string }) {
  const withSegs = phases.filter((t) => t.segments.length > 0)
  if (withSegs.length === 0) return null
  const t0 = Math.min(...withSegs.map((t) => parseT(t.segments[0].start)))
  const t1 = Math.max(...withSegs.map((t) => Math.max(...t.segments.map((s) => parseT(s.end)))))
  const span = Math.max(1, t1 - t0)
  const W = 860
  const LABEL_W = 190
  const ROW_H = 30
  const H = withSegs.length * ROW_H + 26
  const x = (t: number) => LABEL_W + ((t - t0) / span) * (W - LABEL_W - 8)
  // 4 个等分时间刻度
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, t: t0 + span * f }))
  const fmtTick = (t: number) => {
    const d = new Date(t)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {ticks.map(({ f, t }) => (
        <g key={f}>
          <line x1={x(t)} y1={18} x2={x(t)} y2={H - 4} stroke="#3f3f46" strokeWidth="1" strokeDasharray="2,3" />
          <text x={x(t)} y={12} textAnchor="middle" fontSize="9" fill="#71717a">
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {withSegs.map((task, i) => {
        const y = 22 + i * ROW_H
        return (
          <g key={task.taskId}>
            <text x={0} y={y + 14} fontSize="11" fill="#d4d4d8">
              <title>{task.title}</title>
              {`#${task.taskId} ${task.title.length > 12 ? task.title.slice(0, 12) + '…' : task.title}`}
              {task.reworkCount > 0 ? ` ↺${task.reworkCount}` : ''}
            </text>
            {task.segments.map((s, j) => {
              const sx = x(parseT(s.start))
              const ex = x(parseT(s.end))
              const durSec = Math.round((parseT(s.end) - parseT(s.start)) / 1000)
              return (
                <rect
                  key={j}
                  x={sx}
                  y={y}
                  width={Math.max(2, ex - sx)}
                  height={ROW_H - 10}
                  rx={3}
                  fill={PHASE_COLOR[s.phase]}
                  opacity={s.open ? 0.45 : 0.9}
                >
                  <title>{`${phaseLabel(s.phase)}${s.open ? ' (open)' : ''}\n${s.start} → ${s.end}\n${fmtDur(durSec)}`}</title>
                </rect>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

export default function Metrics() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [data, setData] = useState<MetricsResp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api<Project[]>('/api/projects').then((list) => {
      setProjects(list)
      if (list.length > 0) setSelected(list[0].id)
    })
  }, [])

  const load = useCallback(async (id: number) => {
    setErr(null)
    try {
      setData(await api<MetricsResp>(`/api/metrics/${id}`))
    } catch (e) {
      setData(null)
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (selected != null) void load(selected)
  }, [selected, load])

  const phaseLabel = (p: Phase) => t(`metrics.phase_${p}` as Parameters<typeof t>[0])
  const gateLabel = (g: string) => t(`metrics.gate_${g}` as Parameters<typeof t>[0])
  const rate = data && data.first_pass.total > 0 ? Math.round((data.first_pass.passed / data.first_pass.total) * 100) : null

  return (
    <div className="max-w-5xl p-8">
      <PageHeader
        title={t('nav.metrics')}
        desc={t('metrics.desc')}
        right={
          <select
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none"
            value={selected ?? ''}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.id} {p.name}
              </option>
            ))}
          </select>
        }
      />
      {err && <p className="mb-4 text-sm text-rose-400">{err}</p>}
      {data && (
        <>
          <div className="mb-2 flex items-center gap-2 text-sm text-zinc-400">
            <span className="font-medium text-zinc-200">{data.project.name}</span>
            <StatusBadge status={data.project.status} />
          </div>
          <div className="mb-6 grid grid-cols-4 gap-4">
            <Card className="p-4">
              <div className="text-xs text-zinc-500">{t('metrics.wallClock')}</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-100">{fmtDur(data.wall_clock_sec)}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {t('metrics.tasksDone', { done: data.tasks_done, total: data.tasks_total })}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-zinc-500">{t('metrics.cost')}</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-100">${data.usage.cost_usd.toFixed(2)}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {data.tasks_done > 0 ? t('metrics.avgPerTask', { v: (data.usage.cost_usd / data.tasks_done).toFixed(2) }) : '—'} · {data.usage.calls} {t('dash.calls')}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-zinc-500">{t('metrics.firstPass')}</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-100">{rate != null ? `${rate}%` : '—'}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {data.first_pass.passed}/{data.first_pass.total}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-zinc-500">{t('metrics.interventions')}</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-100">{data.interventions.approvals + data.interventions.user_chats}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {t('metrics.interventionsDetail', { a: data.interventions.approvals, c: data.interventions.user_chats, auto: data.interventions.auto_approved })}
              </div>
            </Card>
          </div>

          <h2 className="mb-2 text-sm font-medium text-zinc-400">{t('metrics.gatesTitle')}</h2>
          <Card className="mb-6 p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="pb-2">{t('metrics.gate')}</th>
                  <th className="pb-2 text-right">{t('metrics.gatePass')}</th>
                  <th className="pb-2 text-right">{t('metrics.gateReject')}</th>
                  <th className="pb-2 text-right">{t('metrics.gateRate')}</th>
                </tr>
              </thead>
              <tbody>
                {data.gates.map((g) => {
                  const total = g.pass + g.reject
                  return (
                    <tr key={g.gate} className="border-t border-zinc-800">
                      <td className="py-1.5 text-zinc-300">{gateLabel(g.gate)}</td>
                      <td className="py-1.5 text-right text-emerald-400">{g.pass}</td>
                      <td className={`py-1.5 text-right ${g.reject > 0 ? 'text-rose-400' : 'text-zinc-600'}`}>{g.reject}</td>
                      <td className="py-1.5 text-right text-zinc-400">{total > 0 ? `${Math.round((g.reject / total) * 100)}%` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>

          <h2 className="mb-2 text-sm font-medium text-zinc-400">{t('metrics.timelineTitle')}</h2>
          <Card className="p-4">
            {data.phases.some((p) => p.segments.length > 0) ? (
              <>
                <TimelineSvg phases={data.phases} phaseLabel={phaseLabel} />
                <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-zinc-500">
                  {(Object.keys(PHASE_COLOR) as Phase[]).map((p) => (
                    <span key={p} className="flex items-center gap-1">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PHASE_COLOR[p] }} />
                      {phaseLabel(p)}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-600">{t('metrics.noTimeline')}</p>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
