import { api, useStore } from '../lib/store'
import { agentMeta, type Task } from '../lib/types'
import { agentLabel, useI18n, type I18nKey, type TFunc } from '../lib/i18n'
import { Card, PageHeader } from '../components/ui'

function parseDeps(task: Task): number[] {
  try {
    const arr = JSON.parse(task.deps || '[]')
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

const COLUMNS: Array<{ status: Task['status']; accent: string }> = [
  { status: 'backlog', accent: 'border-zinc-600' },
  { status: 'assigned', accent: 'border-sky-500' },
  { status: 'in_progress', accent: 'border-emerald-500' },
  { status: 'review', accent: 'border-violet-500' },
  { status: 'qa', accent: 'border-cyan-500' },
  { status: 'challenge', accent: 'border-orange-500' },
  { status: 'done', accent: 'border-emerald-600' },
]

function TaskCard({ task, t, all }: { task: Task; t: TFunc; all: Task[] }) {
  const meta = task.assignee ? agentMeta(task.assignee) : null
  const deps = parseDeps(task)
  return (
    <Card className="mb-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-zinc-200">
          <span className="mr-1.5 font-mono text-[11px] text-zinc-600">#{task.id}</span>
          {task.title}
          {task.priority > 0 && <span className="ml-1.5 rounded bg-amber-400/15 px-1 text-[10px] text-amber-300">★</span>}
        </div>
      </div>
      {task.description && <div className="mt-1.5 line-clamp-2 text-xs text-zinc-500">{task.description}</div>}
      {deps.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {deps.map((d) => {
            const dep = all.find((x) => x.id === d)
            const waiting = dep && dep.status !== 'done'
            return (
              <span
                key={d}
                title={waiting ? t('tasks.waitingDep') : undefined}
                className={`rounded px-1.5 py-0.5 text-[10px] ${waiting ? 'bg-amber-400/15 text-amber-300' : 'bg-zinc-700/40 text-zinc-500'}`}
              >
                {t('tasks.dependsOn', { n: d })}
              </span>
            )
          })}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        {meta && task.assignee ? (
          <span className={`text-xs font-medium ${meta.color}`}>{agentLabel(task.assignee, t)}</span>
        ) : (
          <span className="text-xs text-zinc-600">{t('tasks.unassigned')}</span>
        )}
        {task.review_cycles > 0 && <span className="text-[11px] text-rose-400">{t('tasks.rework', { n: task.review_cycles })}</span>}
      </div>
      {task.status === 'blocked' && (
        <>
          {task.review_notes && (
            <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">{task.review_notes}</div>
          )}
          <button
            onClick={() => void api(`/api/tasks/${task.id}/retry`, { method: 'POST', body: '{}' })}
            className="mt-2 rounded-md border border-zinc-600 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ↻ {t('tasks.retry')}
          </button>
        </>
      )}
    </Card>
  )
}

export default function TaskBoardPage() {
  const { state } = useStore()
  const { t } = useI18n()
  const tasks = state?.tasks ?? []
  const blocked = tasks.filter((x) => x.status === 'blocked')

  return (
    <div className="p-8">
      <PageHeader title={t('nav.tasks')} desc={t('tasks.desc')} />

      {blocked.length > 0 && (
        <div className="mb-4">
          <h2 className="mb-2 text-sm font-medium text-rose-400">{t('tasks.blockedWarn')}</h2>
          <div className="grid grid-cols-3 gap-2">
            {blocked.map((x) => (
              <TaskCard key={x.id} task={x} t={t} all={tasks} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-7 gap-3">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((x) => x.status === col.status)
          return (
            <div key={col.status} className="min-w-0">
              <div className={`mb-2 border-l-2 pl-2 ${col.accent}`}>
                <span className="text-sm font-medium text-zinc-300">{t(`status.${col.status}` as I18nKey)}</span>
                <span className="ml-1.5 text-xs text-zinc-600">{colTasks.length}</span>
              </div>
              <div className="min-h-24">
                {colTasks.map((x) => (
                  <TaskCard key={x.id} task={x} t={t} all={tasks} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {tasks.length === 0 && <div className="mt-12 text-center text-sm text-zinc-600">{t('tasks.empty')}</div>}
    </div>
  )
}
