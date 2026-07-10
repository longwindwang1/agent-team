import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useStore } from '../lib/store'
import { agentMeta, type Message, type Task } from '../lib/types'
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
  const { state, subscribe } = useStore()
  const { t } = useI18n()
  const [target, setTarget] = useState<Target>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  // WS 回调里需要最新 target，避免闭包过期
  const targetRef = useRef<Target>(null)
  targetRef.current = target

  const projectId = state?.project?.id ?? null
  const tasks: Task[] = (state?.tasks ?? []).filter((k) => k.project_id === projectId)

  const loadThread = useCallback(async (tg: Target) => {
    const q = tg != null ? `?task_id=${tg}` : ''
    try {
      setMessages(await api<Message[]>(`/api/chat/history${q}`))
    } catch {
      setMessages([])
    }
  }, [])

  useEffect(() => {
    void loadThread(target)
  }, [target, loadThread])

  // WS：命中当前线程的新消息即时追加
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'message') return
      const m = msg.payload as Message
      const tg = targetRef.current
      const inThread = tg != null ? m.task_id === tg : m.task_id == null && m.meeting_id == null && (m.from_agent === 'user' || m.to_agent === 'user')
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
      await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: msg, ...(target != null ? { task_id: target } : {}) }) })
    } catch {
      setText(msg) // 失败还原输入
    } finally {
      setSending(false)
    }
  }

  const focusTask = target != null ? tasks.find((k) => k.id === target) : undefined

  return (
    <div className="flex h-full flex-col p-8">
      <PageHeader title={t('nav.chat')} desc={t('chat.desc')} />
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
