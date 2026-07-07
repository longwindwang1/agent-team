import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppState, WsMsg } from './types'

interface StoreValue {
  state: AppState | null
  refresh: () => Promise<void>
  subscribe: (fn: (msg: WsMsg) => void) => () => void
  connected: boolean
}

const StoreCtx = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Set<(msg: WsMsg) => void>())
  const refetchTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/state')
      if (r.ok) setState(await r.json())
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
      ws = new WebSocket(`${proto}://${location.host}/ws`)
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

  return <StoreCtx.Provider value={{ state, refresh, subscribe, connected }}>{children}</StoreCtx.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(StoreCtx)
  if (!v) throw new Error('useStore must be used within StoreProvider')
  return v
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `请求失败 (${r.status})`)
  }
  return (await r.json()) as T
}
