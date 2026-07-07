import type { ReactNode } from 'react'
import { currentLang, useI18n, type I18nKey } from '../lib/i18n'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-800 bg-zinc-900/50 ${className}`}>{children}</div>
}

export function PageHeader({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
        {desc && <p className="mt-1 text-sm text-zinc-500">{desc}</p>}
      </div>
      {right}
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  // agent
  idle: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
  thinking: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  working: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  waiting_approval: 'bg-rose-400/10 text-rose-300 border-rose-400/30',
  error: 'bg-red-500/15 text-red-400 border-red-500/40',
  // task
  backlog: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
  assigned: 'bg-sky-400/10 text-sky-300 border-sky-400/30',
  in_progress: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  review: 'bg-violet-400/10 text-violet-300 border-violet-400/30',
  qa: 'bg-cyan-400/10 text-cyan-300 border-cyan-400/30',
  challenge: 'bg-orange-400/10 text-orange-300 border-orange-400/30',
  done: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  blocked: 'bg-rose-500/15 text-rose-400 border-rose-500/40',
  // project / approvals / meetings
  running: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  paused: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/40',
  pending: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  approved: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  rejected: 'bg-rose-400/10 text-rose-300 border-rose-400/30',
  open: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  closed: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.idle
  const key = `status.${status}` as I18nKey
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${style}`}>
      {t(key) === key ? status : t(key)}
    </span>
  )
}

export function fmtTime(iso: string): string {
  // SQLite datetime('now') 是 UTC，无时区后缀 — 补 Z 再本地化
  const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z')
  return d.toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
