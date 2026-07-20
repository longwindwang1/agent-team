import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppState, WsMsg } from './types'

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
        // stream 片段只走订阅者，不触发全量刷新
        if (msg.type !== 'stream') {
          if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current)
          refetchTimer.current = window.setTimeout(() => void refresh(), 300)
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!closed) setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      closed = true
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
