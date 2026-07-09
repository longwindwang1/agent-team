import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useStore } from '../lib/store'
import { agentMeta, type Message, type Project, type Task } from '../lib/types'
import { agentLabel, useI18n } from '../lib/i18n'
import { Card, PageHeader, StatusBadge, fmtTime } from '../components/ui'

/** 对话目标：null = 项目整体（协调者），数字 = 具体任务的线程 */
type Target = number | null

function Bubble({ msg }: { msg: Message }) {
  const { t } = useI18n()
  const meta = agentMeta(msg.from_agent)
  const isUser = msg.from_agent === 'user'
  return (
    <div className={`py-2 ${isUser ? 'pl-16' : 'pr-16'}`}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className={`text-sm font-medium ${meta.color}`}>{agentLabel(msg.from_agent, t)}</span>
        <span className="font-mono text-[11px] text-zinc-600">{fmtTime(msg.created_at)}</span>
      </div>
      <div
        className={`whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed text-zinc-200 ${
          isUser ? 'border-emerald-500/30 bg-emerald-500/10' : `${meta.bg} ${meta.border}`
        }`}
      >
        {msg.content}
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { state, subscribe, refresh } = useStore()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [target, setTarget] = useState<Target>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [activating, setActivating] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  // WS 回调里需要最新目标，避免闭包过期
  const ctxRef = useRef<{ target: Target; projectId: number | null }>({ target: null, projectId: null })
  ctxRef.current = { target, projectId }

  const activeProjectId = state?.project?.id ?? null
  // 缺省选中活动项目
  const effProjectId = projectId ?? activeProjectId
  const isActive = effProjectId != null && effProjectId === activeProjectId
  const tasks: Task[] = allTasks.filter((k) => k.project_id === effProjectId)

  useEffect(() => {
    void api<Project[]>('/api/projects').then(setProjects).catch(() => {})
    void api<Task[]>('/api/tasks').then(setAllTasks).catch(() => {})
  }, [state?.project?.id, state?.tasks])

  const loadThread = useCallback(async (tg: Target, pid: number | null) => {
    const q = tg != null ? `?task_id=${tg}` : pid != null ? `?project_id=${pid}` : ''
    try {
      setMessages(await api<Message[]>(`/api/chat/history${q}`))
    } catch {
      setMessages([])
    }
  }, [])

  // 切项目时重置任务目标为"项目整体"
  useEffect(() => {
    setTarget(null)
  }, [effProjectId])

  useEffect(() => {
    void loadThread(target, effProjectId)
  }, [target, effProjectId, loadThread])

  // WS：命中当前线程的新消息即时追加
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'message') return
      const m = msg.payload as Message
      const { target: tg, projectId: pid } = ctxRef.current
      const inThread =
        tg != null
          ? m.task_id === tg
          : m.task_id == null && m.meeting_id == null && m.project_id === pid && (m.from_agent === 'user' || m.to_agent === 'user')
      if (inThread) {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
      }
    })
  }, [subscribe])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async () => {
    const msg = text.trim()
    if (!msg || sending) return
    setSending(true)
    setText('')
    try {
      await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: msg, ...(target != null ? { task_id: target } : {}), ...(effProjectId != null ? { project_id: effProjectId } : {}) }),
      })
    } catch {
      setText(msg) // 失败还原输入
    } finally {
      setSending(false)
    }
  }

  const activate = async () => {
    if (effProjectId == null || activating) return
    setActivating(true)
    try {
      await api(`/api/projects/${effProjectId}/activate`, { method: 'POST', body: '{}' })
      await refresh()
    } finally {
      setActivating(false)
    }
  }

  const focusTask = target != null ? tasks.find((k) => k.id === target) : undefined
  const effProject = projects.find((p) => p.id === effProjectId)

  return (
    <div className="flex h-full flex-col p-8">
      <PageHeader title={t('nav.chat')} desc={t('chat.desc')} />
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-zinc-500">{t('chat.project')}</span>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          value={effProjectId ?? ''}
          onChange={(e) => setProjectId(Number(e.target.value))}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              #{p.id} {p.name} [{p.status}]
            </option>
          ))}
        </select>
        {isActive ? (
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">{t('chat.activeBadge')}</span>
        ) : (
          <>
            <span className="rounded bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">{t('chat.archivedBadge')}</span>
            <button
              onClick={() => void activate()}
              disabled={activating}
              className="rounded-md border border-emerald-700 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-500 disabled:opacity-40"
            >
              {activating ? t('chat.activating') : t('chat.activate')}
            </button>
          </>
        )}
      </div>
      {!isActive && effProject && <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t('chat.archivedHint')}</div>}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* 对话目标列表 */}
        <Card className="w-72 shrink-0 overflow-y-auto p-2">
          <button
            onClick={() => setTarget(null)}
            className={`mb-1 block w-full rounded-md px-3 py-2.5 text-left transition-colors ${target == null ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}
          >
            <div className="text-sm text-zinc-200">{t('chat.projectThread')}</div>
            <div className="mt-0.5 text-[11px] text-zinc-600">{t('chat.projectThreadDesc')}</div>
          </button>
          <div className="my-1 border-t border-zinc-800" />
          {tasks.length === 0 && <div className="p-3 text-sm text-zinc-600">{t('chat.noTasks')}</div>}
          {tasks.map((k) => (
            <button
              key={k.id}
              onClick={() => setTarget(k.id)}
              className={`mb-1 block w-full rounded-md px-3 py-2 text-left transition-colors ${target === k.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-zinc-600">#{k.id}</span>
                <StatusBadge status={k.status} />
              </div>
              <div className="mt-1 truncate text-sm text-zinc-200">{k.title}</div>
            </button>
          ))}
        </Card>

        {/* 线程 + 输入 */}
        <Card className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="text-sm font-medium text-zinc-100">
              {focusTask ? `#${focusTask.id} ${focusTask.title}` : t('chat.projectThread')}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">{focusTask ? t('chat.taskThreadHint') : t('chat.projectHint')}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
            {messages.length === 0 && <div className="p-6 text-sm text-zinc-600">{t('chat.empty')}</div>}
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-zinc-800 p-3">
            <div className="flex gap-2">
              <input
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder={focusTask ? t('chat.phTask', { id: focusTask.id }) : t('chat.ph')}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send()
                }}
              />
              <button
                onClick={() => void send()}
                disabled={sending || !text.trim()}
                className="shrink-0 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {sending ? t('meet.chatSending') : t('meet.chatSend')}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
