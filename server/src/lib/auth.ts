import { timingSafeEqual } from 'node:crypto'

/** 恒时比较 token（长度不同直接 false，不泄露长度之外的信息） */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 本机回环 Origin（localhost/127.0.0.1 任意端口，http/https） */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

/**
 * CORS 白名单：无 Origin（curl/同源/经 vite 代理）放行；回环放行；
 * 其余仅当出现在 cors_origins 设置（逗号分隔）里才放行。
 */
export function isAllowedOrigin(origin: string | undefined, extraCsv: string): boolean {
  if (!origin) return true
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true
  return extraCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin)
}
