import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { agentMeta, type Message } from '../lib/types'
import { agentLabel, useI18n, type I18nKey } from '../lib/i18n'
import { Card, PageHeader, StatusBadge, fmtTime } from '../components/ui'

function Bubble({ msg }: { msg: Message }) {
  const { t } = useI18n()
  const meta = agentMeta(msg.from_agent)
  return (
    <div className="py-2">
      <div className="mb-1 flex items-baseline gap-2">
        <span className={`text-sm font-medium ${meta.color}`}>{agentLabel(msg.from_agent, t)}</span>
        {msg.to_agent && <span className="text-xs text-zinc-500">→ {agentLabel(msg.to_agent, t)}</span>}
        <span className="font-mono text-[11px] text-zinc-600">{fmtTime(msg.created_at)}</span>
      </div>
      <div className={`whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed text-zinc-200 ${meta.bg} ${meta.border}`}>
        {msg.content}
      </div>
    </div>
  )
}

export default function MeetingRoom() {
  const { state, subscribe } = useStore()
  const { t } = useI18n()
  const [selected, setSelected] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [live, setLive] = useState<{ agent: string; text: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const meetings = state?.meetings ?? []
  // id 0 = 团队频道（私信与系统消息）
  const activeId = selected ?? meetings[0]?.id ?? 0

  // 拉取所选会议/频道的消息
  useEffect(() => {
    let cancelled = false
    const url = activeId === 0 ? '/api/messages/direct' : `/api/meetings/${activeId}/messages`
    void fetch(url)
      .then((r) => r.json())
      .then((rows: Message[]) => {
        if (!cancelled) setMessages(rows)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // WS：新消息追加 / 流式片段展示
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'message') {
        const m = msg.payload as Message
        if ((m.meeting_id ?? 0) === activeId) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
          setLive(null)
        }
      } else if (msg.type === 'stream') {
        const p = msg.payload as { agent_id: string; text: string; meeting_id?: number | null }
        if ((p.meeting_id ?? 0) === activeId) {
          setLive((prev) =>
            prev && prev.agent === p.agent_id ? { agent: p.agent_id, text: prev.text + p.text } : { agent: p.agent_id, text: p.text },
          )
        }
      }
    })
  }, [subscribe, activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, live])

  const activeMeeting = meetings.find((m) => m.id === activeId)

  return (
    <div className="flex h-full flex-col p-8">
      <PageHeader title={t('nav.meetings')} desc={t('meet.desc')} />
      <div className="flex min-h-0 flex-1 gap-4">
        {/* 会议列表 */}
        <Card className="w-64 shrink-0 overflow-y-auto p-2">
          <button
            onClick={() => setSelected(0)}
            className={`mb-1 block w-full rounded-md px-3 py-2.5 text-left transition-colors ${
              activeId === 0 ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
            }`}
          >
            <div className="text-sm text-zinc-200">{t('meet.channel')}</div>
            <div className="mt-0.5 text-[11px] text-zinc-600">{t('meet.channelDesc')}</div>
          </button>
          {meetings.length === 0 ? (
            <div className="p-4 text-sm text-zinc-600">{t('meet.empty')}</div>
          ) : (
            meetings.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`mb-1 block w-full rounded-md px-3 py-2.5 text-left transition-colors ${
                  m.id === activeId ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-400">{t(`mtype.${m.type}` as I18nKey)}</span>
                  <StatusBadge status={m.status} />
                </div>
                <div className="mt-1 truncate text-sm text-zinc-200">{m.topic}</div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-600">{fmtTime(m.created_at)}</div>
              </button>
            ))
          )}
        </Card>

        {/* 消息区 */}
        <Card className="flex min-w-0 flex-1 flex-col">
          {activeMeeting || activeId === 0 ? (
            <>
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-medium text-zinc-100">{activeMeeting?.topic ?? t('meet.channel')}</div>
                {activeMeeting?.summary && (
                  <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-500">
                    {t('meet.summary')}：{activeMeeting.summary}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                {messages.map((m) => (
                  <Bubble key={m.id} msg={m} />
                ))}
                {live && (
                  <div className="py-2 opacity-80">
                    <div className={`mb-1 text-sm font-medium ${agentMeta(live.agent).color}`}>
                      {agentLabel(live.agent, t)}
                      <span className="ml-2 animate-pulse text-xs text-zinc-500">{t('meet.typing')}</span>
                    </div>
                    <div className="whitespace-pre-wrap rounded-lg border border-zinc-700 bg-zinc-800/40 px-3.5 py-2.5 text-sm text-zinc-300">
                      {live.text}
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">{t('meet.pick')}</div>
          )}
        </Card>
      </div>
    </div>
  )
}
