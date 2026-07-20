import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppState, WsMsg } from './types'
import { applyWs } from './mergeWs'

interface StoreValue {
  state: AppState | null
  refresh: () => Promise<void>
  subscribe: (fn: (msg: WsMsg) => void) => () => void
  connected: boolean
  /** 服务端开了 auth_token 且本地没有/失效 → App 显示解锁遮罩 */
  authRequired: boolean
}

const StoreCtx = createContext<StoreValue | null>(null)

/** 本地保存的访问 token（服务端设置了 auth_token 时用）；api()/WS 自动携带 */
export const getAuthToken = (): string => localStorage.getItem('auth_token') ?? ''
export const setAuthToken = (t: string): void => localStorage.setItem('auth_token', t)
export const authHeaders = (): Record<string, string> => {
  const t = getAuthToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [connected, setConnected] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const listeners = useRef(new Set<(msg: WsMsg) => void>())
  const refetchTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/state', { headers: authHeaders() })
      if (r.status === 401) {
        setAuthRequired(true)
        return
      }
      if (r.ok) {
        setAuthRequired(false)
        setState(await r.json())
      }
    } catch {
      // server 未启动时静默重试
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 慢速兜底同步：成本/用量没有专属 WS 消息类型，30s 全量对齐一次（增量合并让高频路径零重拉）
    const slowSync = window.setInterval(() => void refresh(), 30_000)
    let ws: WebSocket | null = null
    let closed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const t = getAuthToken()
      ws = new WebSocket(`${proto}://${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ''}`)
      ws.onopen = () => setConnected(true)
      ws.onmessage = (ev) => {
        let msg: WsMsg
        try {
          msg = JSON.parse(ev.data as string) as WsMsg
        } catch {
          return
        }
        listeners.current.forEach((l) => l(msg))
        // 增量合并进快照；合并不了的消息（活动项目切换/新会议/异常 payload）才回退全量刷新。
        // 历史行为是每条消息全量重拉 /api/state——项目一跑起来就是刷新风暴，历史越长越慢
        setState((cur) => {
          if (!cur) return cur
          const next = applyWs(cur, msg)
          if (next === null) {
            if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current)
            refetchTimer.current = window.setTimeout(() => void refresh(), 300)
            return cur
          }
          return next
        })
      }
      ws.onclose = () => {
        setConnected(false)
        if (!closed) setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      closed = true
      window.clearInterval(slowSync)
      ws?.close()
    }
  }, [refresh])

  const subscribe = useCallback((fn: (msg: WsMsg) => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  return <StoreCtx.Provider value={{ state, refresh, subscribe, connected, authRequired }}>{children}</StoreCtx.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(StoreCtx)
  if (!v) throw new Error('useStore must be used within StoreProvider')
  return v
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `请求失败 (${r.status})`)
  }
  return (await r.json()) as T
}
