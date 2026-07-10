import { describe, expect, it } from 'vitest'
// providers.ts 是纯函数模块（不 import db），可直接引入
import {
  buildProviderEnv,
  computeCostUsd,
  isQuotaError,
  maskProvider,
  resolveModelSpec,
  PROVIDER_ID_RE,
  PROVIDER_PRESETS,
  type ProviderRow,
} from '../src/providers'

function fakeProvider(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/anthropic',
    api_key: 'sk-test-1234abcd',
    small_fast_model: 'deepseek-v4-flash',
    balance_adapter: 'deepseek',
    recharge_url: 'https://platform.deepseek.com/top_up',
    models_json: JSON.stringify([
      { id: 'deepseek-v4-flash', input_per_mtok: 0.14, output_per_mtok: 0.28, cache_read_per_mtok: 0.0028 },
    ]),
    created_at: '2026-07-07',
    updated_at: '2026-07-07',
    ...over,
  }
}

describe('resolveModelSpec 模型引用解析', () => {
  const providers = [fakeProvider()]

  it('裸名 → 官方 Anthropic', () => {
    expect(resolveModelSpec('claude-sonnet-5', providers)).toEqual({ kind: 'anthropic', model: 'claude-sonnet-5' })
  })

  it('空值回退默认官方模型', () => {
    expect(resolveModelSpec('', providers)).toEqual({ kind: 'anthropic', model: 'claude-opus-4-8' })
  })

  it('providerId/modelId 命中并带出价格', () => {
    const spec = resolveModelSpec('deepseek/deepseek-v4-flash', providers)
    expect(spec.kind).toBe('provider')
    if (spec.kind === 'provider') {
      expect(spec.modelId).toBe('deepseek-v4-flash')
      expect(spec.pricing?.input_per_mtok).toBe(0.14)
    }
  })

  it('modelId 自身含斜杠时按第一个 / 切分', () => {
    const spec = resolveModelSpec('deepseek/org/model-x', providers)
    expect(spec.kind).toBe('provider')
    if (spec.kind === 'provider') expect(spec.modelId).toBe('org/model-x')
  })

  it('未知 provider 前缀 → fallback 而非透传（防官方端点 404）', () => {
    const spec = resolveModelSpec('nonexist/some-model', providers)
    expect(spec.kind).toBe('fallback')
    if (spec.kind === 'fallback') expect(spec.model).toBe('claude-opus-4-8')
  })

  it('命中 provider 但模型不在价格表 → pricing 为 null', () => {
    const spec = resolveModelSpec('deepseek/unlisted-model', providers)
    expect(spec.kind).toBe('provider')
    if (spec.kind === 'provider') expect(spec.pricing).toBeNull()
  })
})

describe('buildProviderEnv 环境变量构造', () => {
  it('spread 保留原变量并写入第三方端点', () => {
    const env = buildProviderEnv(fakeProvider(), { PATH: 'C:\\x', SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv)
    expect(env.PATH).toBe('C:\\x')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-1234abcd')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-v4-flash')
  })

  it('大小写不敏感清除宿主残留凭据/路由变量', () => {
    const env = buildProviderEnv(fakeProvider({ small_fast_model: null }), {
      Anthropic_Api_Key: 'leak',
      ANTHROPIC_BASE_URL: 'https://other',
      anthropic_small_fast_model: 'stale',
      CLAUDE_CODE_USE_BEDROCK: '1',
      Path: 'keep',
    } as unknown as NodeJS.ProcessEnv)
    expect(env.Anthropic_Api_Key).toBeUndefined()
    expect(env.anthropic_small_fast_model).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    expect(env.Path).toBe('keep')
  })
})

describe('computeCostUsd 第三方计价', () => {
  it('按百万 tokens 单价累加', () => {
    const cost = computeCostUsd(
      { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 2_000_000, cache_write_tokens: 0 },
      { id: 'm', input_per_mtok: 0.14, output_per_mtok: 0.28, cache_read_per_mtok: 0.0028 },
    )
    // 0.14 + 0.14 + 0.0056
    expect(cost).toBeCloseTo(0.2856, 6)
  })

  it('无价格表回 0；缺省字段按 0', () => {
    const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 100, cache_write_tokens: 100 }
    expect(computeCostUsd(usage, null)).toBe(0)
    expect(computeCostUsd(usage, { id: 'm', output_per_mtok: 1 })).toBeCloseTo(100 / 1e6, 9)
  })
})

describe('maskProvider 脱敏', () => {
  it('去 key 留尾巴', () => {
    const m = maskProvider(fakeProvider())
    expect((m as Record<string, unknown>).api_key).toBeUndefined()
    expect(m.has_key).toBe(true)
    expect(m.key_tail).toBe('abcd')
    expect(m.models[0].id).toBe('deepseek-v4-flash')
  })

  it('无 key 时 has_key=false', () => {
    const m = maskProvider(fakeProvider({ api_key: '' }))
    expect(m.has_key).toBe(false)
    expect(m.key_tail).toBe('')
  })
})

describe('isQuotaError 配额/限流识别', () => {
  it('官方订阅与通用限流', () => {
    expect(isQuotaError("You've hit your session limit · resets 11:10pm")).toBe(true)
    expect(isQuotaError('429 Too Many Requests')).toBe(true)
    expect(isQuotaError('rate_limit_error: exceeded')).toBe(true)
    expect(isQuotaError('server overloaded, retry later')).toBe(true)
  })

  it('第三方余额/欠费（中英文）', () => {
    expect(isQuotaError('402 Insufficient Balance')).toBe(true)
    expect(isQuotaError('账户余额不足，请充值')).toBe(true)
    expect(isQuotaError('您已欠费')).toBe(true)
    expect(isQuotaError('请求被限流，并发超过上限')).toBe(true)
    expect(isQuotaError('insufficient quota for this request')).toBe(true)
  })

  it('认证错误不误报（key 配错应显性暴露而非暂停等恢复）', () => {
    expect(isQuotaError('401 Unauthorized')).toBe(false)
    expect(isQuotaError('authentication_error: invalid x-api-key')).toBe(false)
    expect(isQuotaError('invalid api key provided')).toBe(false)
    expect(isQuotaError('无效的密钥')).toBe(false)
  })

  it('普通错误不误报', () => {
    expect(isQuotaError('TypeError: cannot read properties of undefined')).toBe(false)
    expect(isQuotaError('merge conflict in src/options.js')).toBe(false)
  })
})

describe('PROVIDER_PRESETS 预设完整性', () => {
  it('id 合法、必填字段齐全、价格为正', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.id).toMatch(PROVIDER_ID_RE)
      // 明文 http 只允许本机回环（LiteLLM 等本地转换代理）；远程端点必须 https
      expect(p.base_url).toMatch(/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)([:/]|$))/)
      expect(p.recharge_url).toMatch(/^https:\/\//)
      expect(p.models.length).toBeGreaterThan(0)
      for (const m of p.models) {
        expect(m.input_per_mtok).toBeGreaterThan(0)
        expect(m.output_per_mtok).toBeGreaterThan(0)
      }
    }
  })
})

describe('OpenAI（经 LiteLLM）预设接线', () => {
  const preset = PROVIDER_PRESETS.find((p) => p.id === 'openai')!

  it('预设存在：本地代理端点、无余额适配器、小模型映射', () => {
    expect(preset).toBeDefined()
    expect(preset.base_url).toBe('http://127.0.0.1:4000')
    expect(preset.balance_adapter).toBe('none')
    expect(preset.small_fast_model).toBe('gpt-5-mini')
    expect(preset.note).toContain('LiteLLM')
  })

  it('effort 不透传：全部模型 supports_effort 缺省（agentPool 只在显式 true 时传 effort）', () => {
    for (const m of preset.models) {
      expect(m.supports_effort).not.toBe(true)
    }
    const provider = fakeProvider({ id: 'openai', base_url: preset.base_url, models_json: JSON.stringify(preset.models), small_fast_model: preset.small_fast_model })
    const spec = resolveModelSpec('openai/gpt-5.1', [provider])
    expect(spec.kind).toBe('provider')
    if (spec.kind === 'provider') {
      expect(spec.modelId).toBe('gpt-5.1')
      expect(spec.pricing?.supports_effort).toBeUndefined()
    }
  })

  it('会话环境注入指向本地代理 + 小模型映射', () => {
    const provider = fakeProvider({ id: 'openai', base_url: preset.base_url, api_key: 'sk-litellm-master', small_fast_model: preset.small_fast_model, models_json: JSON.stringify(preset.models) })
    const env = buildProviderEnv(provider, { PATH: 'x' })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4000')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-litellm-master')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5-mini')
  })

  it('GPT 计价按预设牌价本地记账（LiteLLM 报的成本不采信）', () => {
    const pricing = preset.models.find((m) => m.id === 'gpt-5-mini')!
    const cost = computeCostUsd({ input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 0, cache_write_tokens: 0 }, pricing)
    expect(cost).toBeCloseTo(0.25 + 1.0, 6) // 1M 输入 $0.25 + 0.5M 输出 $1.00
  })
})
