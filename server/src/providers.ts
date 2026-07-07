// 第三方模型提供商（Anthropic 兼容端点）核心逻辑。
// 本模块只放纯函数与预设表，不 import db——单测可直接引入而不拉起数据库副作用。

export interface ProviderModel {
  id: string
  label?: string
  /** 单价：美元 / 百万 tokens，缺省按 0 */
  input_per_mtok?: number
  output_per_mtok?: number
  cache_read_per_mtok?: number
  cache_write_per_mtok?: number
  /** 端点是否接受 Claude Code 的 effort 字段；默认 false（第三方对未知字段容忍度不一） */
  supports_effort?: boolean
}

export interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_key: string
  small_fast_model: string | null
  balance_adapter: string // none|deepseek|moonshot
  recharge_url: string | null
  models_json: string
  created_at: string
  updated_at: string
}

export const PROVIDER_ID_RE = /^[a-z0-9_-]{1,32}$/

export function parseModels(models_json: string): ProviderModel[] {
  try {
    const arr = JSON.parse(models_json)
    return Array.isArray(arr) ? arr.filter((m) => m && typeof m.id === 'string') : []
  } catch {
    return []
  }
}

// ---------- model.<role> 值解析 ----------

export type ModelSpec =
  | { kind: 'anthropic'; model: string }
  | { kind: 'provider'; provider: ProviderRow; modelId: string; pricing: ProviderModel | null }
  | { kind: 'fallback'; model: string; reason: string }

export const DEFAULT_MODEL = 'claude-opus-4-8'

/**
 * 解析 model.<role> 设置值。裸名 = 官方 Anthropic；"providerId/modelId"（按第一个 / 切分）= 第三方；
 * 前缀不是已知 provider 时回退默认模型——绝不能把 "x/y" 透传给官方端点（404）。
 */
export function resolveModelSpec(raw: string, providers: ProviderRow[]): ModelSpec {
  const value = (raw || '').trim() || DEFAULT_MODEL
  const slash = value.indexOf('/')
  if (slash <= 0) return { kind: 'anthropic', model: value }
  const providerId = value.slice(0, slash)
  const modelId = value.slice(slash + 1)
  const provider = providers.find((p) => p.id === providerId)
  if (!provider || !modelId) {
    return { kind: 'fallback', model: DEFAULT_MODEL, reason: `未知的提供商引用: ${value}` }
  }
  const pricing = parseModels(provider.models_json).find((m) => m.id === modelId) ?? null
  return { kind: 'provider', provider, modelId, pricing }
}

// ---------- 会话环境变量 ----------

/** 会污染路由/凭据的环境变量（大小写不敏感匹配删除） */
const SCRUB_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]

/**
 * 构造第三方会话的 env。SDK 的 Options.env 是整体替换而非合并，
 * 必须 spread 完整 base（保住 PATH/SystemRoot 等 Windows 必需变量）。
 * Windows 上 process.env 键大小写不敏感，但 spread 后是普通对象且保留原始大小写（如 Path），
 * 所以删除必须遍历键做大小写不敏感比对。
 */
export function buildProviderEnv(provider: ProviderRow, base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  const scrub = new Set(SCRUB_ENV_KEYS)
  for (const key of Object.keys(env)) {
    if (scrub.has(key.toUpperCase())) delete env[key]
  }
  env.ANTHROPIC_BASE_URL = provider.base_url
  env.ANTHROPIC_AUTH_TOKEN = provider.api_key
  if (provider.small_fast_model) env.ANTHROPIC_SMALL_FAST_MODEL = provider.small_fast_model
  return env
}

// ---------- 计价 ----------

export interface UsageTokens {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

/** 第三方按 provider 价格表自算成本（美元）；缺省价格字段按 0 */
export function computeCostUsd(usage: UsageTokens, pricing: ProviderModel | null): number {
  if (!pricing) return 0
  return (
    (usage.input_tokens * (pricing.input_per_mtok ?? 0) +
      usage.output_tokens * (pricing.output_per_mtok ?? 0) +
      usage.cache_read_tokens * (pricing.cache_read_per_mtok ?? 0) +
      usage.cache_write_tokens * (pricing.cache_write_per_mtok ?? 0)) /
    1e6
  )
}

// ---------- 出接口脱敏 ----------

export interface MaskedProvider {
  id: string
  name: string
  base_url: string
  small_fast_model: string | null
  balance_adapter: string
  recharge_url: string | null
  models: ProviderModel[]
  has_key: boolean
  key_tail: string
}

/** api_key 绝不出接口：只回有无 + 后 4 位 */
export function maskProvider(row: ProviderRow): MaskedProvider {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    small_fast_model: row.small_fast_model,
    balance_adapter: row.balance_adapter,
    recharge_url: row.recharge_url,
    models: parseModels(row.models_json),
    has_key: row.api_key.length > 0,
    key_tail: row.api_key.slice(-4),
  }
}

// ---------- 配额/限流错误识别 ----------

const AUTH_ERROR_RE = /\b401\b|authentication|unauthorized|invalid\s*(api[\s_-]?key|token)|无效.{0,4}(密钥|key)/i
const QUOTA_ERROR_RE =
  /session limit|rate.?limit|overloaded|quota|too many requests|concurrenc|insufficient\s+(balance|credits|quota)|payment required|\b429\b|\b402\b|余额不足|欠费|账户余额|限流|并发.{0,6}(上限|限制)/i

/**
 * 可恢复的配额/限流/欠费类错误 → 暂停项目等恢复。
 * 认证错误（key 配错）明确排除：应走 task blocked 显性暴露，而不是无限暂停。
 */
export function isQuotaError(message: string): boolean {
  if (AUTH_ERROR_RE.test(message)) return false
  return QUOTA_ERROR_RE.test(message)
}

// ---------- 余额查询适配器 ----------

export interface BalanceEntry {
  currency: string
  amount: number
}

type BalanceFetcher = (provider: ProviderRow) => Promise<BalanceEntry[]>

async function fetchJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

const BALANCE_ADAPTERS: Record<string, BalanceFetcher> = {
  // https://api-docs.deepseek.com — GET /user/balance → { balance_infos: [{currency, total_balance, ...}] }
  deepseek: async (p) => {
    const url = new URL(p.base_url)
    const data = await fetchJson(`${url.origin}/user/balance`, p.api_key)
    const infos = (data.balance_infos ?? []) as Array<{ currency?: string; total_balance?: string | number }>
    return infos.map((b) => ({ currency: b.currency ?? 'CNY', amount: Number(b.total_balance ?? 0) }))
  },
  // https://platform.moonshot.cn — GET /v1/users/me/balance → { data: { available_balance, ... } }
  moonshot: async (p) => {
    const url = new URL(p.base_url)
    const data = await fetchJson(`${url.origin}/v1/users/me/balance`, p.api_key)
    const d = (data.data ?? {}) as { available_balance?: number }
    return [{ currency: 'CNY', amount: Number(d.available_balance ?? 0) }]
  },
}

/** 按 balance_adapter 查余额；'none'/未知适配器/无 key 返回 null（前端显示 —） */
export async function fetchBalance(provider: ProviderRow): Promise<BalanceEntry[] | null> {
  const adapter = BALANCE_ADAPTERS[provider.balance_adapter]
  if (!adapter || !provider.api_key) return null
  return adapter(provider)
}

// ---------- 预设 ----------

export interface ProviderPreset {
  id: string
  name: string
  base_url: string
  small_fast_model: string | null
  balance_adapter: string
  recharge_url: string
  models: ProviderModel[]
  /** 未实测标记：端点/价格来自公开文档，接入前建议自行核对 */
  note?: string
}

// 价格为 2026-07 公开牌价（美元/百万 tokens），各家调价频繁，仅作默认值，可在设置页修改
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/anthropic',
    small_fast_model: 'deepseek-v4-flash',
    balance_adapter: 'deepseek',
    recharge_url: 'https://platform.deepseek.com/top_up',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', input_per_mtok: 0.14, output_per_mtok: 0.28, cache_read_per_mtok: 0.0028, cache_write_per_mtok: 0.14 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', input_per_mtok: 1.74, output_per_mtok: 3.48, cache_read_per_mtok: 0.0145, cache_write_per_mtok: 1.74 },
    ],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/anthropic',
    small_fast_model: 'glm-4.5-air',
    balance_adapter: 'none', // 智谱无公开余额查询接口
    recharge_url: 'https://open.bigmodel.cn/finance/pay',
    models: [
      { id: 'glm-4.7', label: 'GLM-4.7', input_per_mtok: 0.6, output_per_mtok: 2.2, cache_read_per_mtok: 0.11, cache_write_per_mtok: 0.6 },
      { id: 'glm-5.1', label: 'GLM-5.1', input_per_mtok: 0.97, output_per_mtok: 3.04, cache_read_per_mtok: 0.17, cache_write_per_mtok: 0.97 },
      { id: 'glm-4.5-air', label: 'GLM-4.5-Air', input_per_mtok: 0.2, output_per_mtok: 1.1, cache_read_per_mtok: 0.03, cache_write_per_mtok: 0.2 },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    base_url: 'https://api.moonshot.cn/anthropic',
    small_fast_model: 'kimi-k2.5',
    balance_adapter: 'moonshot',
    recharge_url: 'https://platform.moonshot.cn/console/pay',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6', input_per_mtok: 0.95, output_per_mtok: 4.0, cache_read_per_mtok: 0.16, cache_write_per_mtok: 0.95 },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', input_per_mtok: 0.6, output_per_mtok: 3.0, cache_read_per_mtok: 0.1, cache_write_per_mtok: 0.6 },
    ],
    note: '端点与价格来自公开文档，未实测',
  },
]
