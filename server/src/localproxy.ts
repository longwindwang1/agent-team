import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { listProviders } from './db/dao'
import type { ProviderRow } from './providers'
import { getSetting, roleEnabled } from './settings'
import { ROOT_DIR } from './lib/paths'
import { logEvent } from './events'

/**
 * LiteLLM sidecar 托管：启用角色的模型指向本机回环代理（如 OpenAI 经 LiteLLM）时，
 * 平台自动拉起/健康检查/随服务关闭——用户无需手动起代理。
 * 失败一律显性化（proxy.failed 事件 + 状态接口），绝不静默让任务莫名连接失败。
 */

/** 与 engine 的角色清单一致（此处复制避免引入 engine 的重依赖环） */
const ALL_ROLES = ['coordinator', 'architect', 'frontend', 'backend', 'reviewer', 'qa', 'challenger', 'ba', 'devops', 'scribe'] as const

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i

export interface LocalProxyStatus {
  /** idle=无角色在用本地代理 | starting | running | failed */
  status: 'idle' | 'starting' | 'running' | 'failed'
  port: number | null
  detail: string | null
}

/** 纯函数：模型引用（model.<role> 值）里是否有指向回环代理的 provider，回其 base_url（无则 null） */
export function findLoopbackBaseUrl(modelRefs: string[], providers: Pick<ProviderRow, 'id' | 'base_url'>[]): string | null {
  for (const ref of modelRefs) {
    const slash = ref.indexOf('/')
    if (slash <= 0) continue // 裸名 = 官方模型
    const provider = providers.find((p) => p.id === ref.slice(0, slash))
    if (provider && LOOPBACK_RE.test(provider.base_url)) return provider.base_url
  }
  return null
}

let child: ChildProcess | null = null
let state: LocalProxyStatus = { status: 'idle', port: null, detail: null }
let exitHookInstalled = false

export function getLocalProxyStatus(): LocalProxyStatus {
  return state
}

/** 端口是否有服务在听：任何 HTTP 响应（含 404）都算活，只有连接失败算死 */
async function portAlive(base: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 1500)
  try {
    await fetch(`${base.replace(/\/+$/, '')}/health/liveliness`, { signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 并发互斥：多项目同时启动时共享同一次 ensure（否则两个调用都看到端口未活，双拉起 litellm） */
let ensureInflight: Promise<LocalProxyStatus> | null = null

/**
 * 需要则确保本地代理活着（幂等，可重复调用，并发调用合并为一次）：
 * 无角色在用回环 provider → idle；端口已活（外部自己起的也算）→ running；
 * 否则按 litellm_config 设置拉起 litellm 子进程并轮询健康（30s 超时）。
 */
export function ensureLocalProxy(): Promise<LocalProxyStatus> {
  if (!ensureInflight) {
    ensureInflight = doEnsureLocalProxy().finally(() => {
      ensureInflight = null
    })
  }
  return ensureInflight
}

async function doEnsureLocalProxy(): Promise<LocalProxyStatus> {
  const refs = ALL_ROLES.filter((id) => roleEnabled(id)).map((id) => getSetting(`model.${id}`))
  const base = findLoopbackBaseUrl(refs, listProviders())
  if (!base) {
    if (state.status === 'running' && child) stopLocalProxy() // 不再需要（模型改走别家）→ 收掉托管的
    else state = { status: 'idle', port: null, detail: null }
    return state
  }
  const port = Number(new URL(base).port || 80)

  if (await portAlive(base)) {
    if (state.status !== 'running') {
      state = { status: 'running', port, detail: child ? '由平台托管' : '外部进程' }
    }
    return state
  }
  if (state.status === 'starting') return state // 已有一次启动在途

  const cfgSetting = getSetting('litellm_config') || 'litellm-config.yaml'
  const cfgPath = path.isAbsolute(cfgSetting) ? cfgSetting : path.join(ROOT_DIR, cfgSetting)
  if (!existsSync(cfgPath)) {
    state = { status: 'failed', port, detail: `缺少 LiteLLM 配置：${cfgPath}（写法见 README「接 OpenAI」）` }
    logEvent('proxy.failed', null, { reason: 'config_missing', path: cfgPath })
    return state
  }

  state = { status: 'starting', port, detail: null }
  logEvent('proxy.starting', null, { port, config: cfgPath })
  let tail = ''
  // 不走 shell：Windows CreateProcess 会自动补 .exe（pip 的 console script 就是 litellm.exe），
  // child.pid 即 litellm 本体，kill 干净；找不到可执行文件 → ENOENT 显性提示安装命令
  child = spawn('litellm', ['--config', cfgPath, '--port', String(port)], { windowsHide: true })
  child.stdout?.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-1000)))
  child.stderr?.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-1000)))
  child.on('error', (err) => {
    const hint = err.message.includes('ENOENT') ? 'litellm 未安装：pip install "litellm[proxy]"（需 Python）' : err.message.slice(0, 200)
    state = { status: 'failed', port, detail: hint }
    logEvent('proxy.failed', null, { error: err.message.slice(0, 200) })
    child = null
  })
  child.on('exit', (code) => {
    if (state.status === 'running') {
      // 运行中意外退出（如被外部杀掉）：下次 ensureLocalProxy 会重拉
      state = { status: 'failed', port, detail: `代理进程退出（code=${code}）` }
      logEvent('proxy.exited', null, { code })
    }
    child = null
  })
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      try {
        child?.kill()
      } catch {
        // 进程收尾，尽力而为
      }
    })
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    if (state.status === 'failed') return state // spawn error 已定性
    if (await portAlive(base)) {
      state = { status: 'running', port, detail: '由平台托管' }
      logEvent('proxy.started', null, { port })
      return state
    }
  }
  state = { status: 'failed', port, detail: `启动超时（30s）。输出尾部：${tail.slice(-300) || '（无）'}` }
  logEvent('proxy.failed', null, { reason: 'timeout', tail: tail.slice(-300) })
  try {
    child?.kill()
  } catch {
    // 已死则忽略
  }
  child = null
  return state
}

/** 服务关闭时收掉托管的代理（外部自己起的不动） */
export function stopLocalProxy(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      // 已死则忽略
    }
    child = null
    logEvent('proxy.stopped', null, {})
  }
  state = { status: 'idle', port: null, detail: null }
}
