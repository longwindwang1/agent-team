import { allSettings, getSettingRaw, setSetting } from './db/dao'

export const SETTING_DEFAULTS: Record<string, string> = {
  // 汇报周期：cron 表达式；test 模式下用每 2 分钟便于验证
  report_cron: '0 */2 * * *',
  report_test_mode: 'off', // off | fast(每2分钟)
  // 预算（美元），超出后熔断并请求用户审批
  budget_usd: '10',
  // 各角色模型：高价值低频角色用 opus，工作马力用 sonnet，提炼用 haiku（可在设置页调整）
  'model.coordinator': 'claude-opus-4-8',
  'model.architect': 'claude-opus-4-8',
  'model.ba': 'claude-opus-4-8',
  'model.frontend': 'claude-sonnet-5',
  'model.backend': 'claude-sonnet-5',
  'model.reviewer': 'claude-sonnet-5',
  'model.qa': 'claude-sonnet-5',
  'model.challenger': 'claude-sonnet-5',
  'model.devops': 'claude-sonnet-5',
  'model.scribe': 'claude-haiku-4-5',
  // 各角色 effort（thinking/行动预算分级）
  'effort.coordinator': 'medium',
  'effort.architect': 'high',
  'effort.ba': 'high',
  'effort.frontend': 'high',
  'effort.backend': 'high',
  'effort.reviewer': 'medium',
  'effort.qa': 'medium',
  'effort.challenger': 'medium',
  'effort.devops': 'medium',
  'effort.scribe': 'low',
  // 按需启用角色（coordinator/frontend/backend 常驻不可关）；关闭 = 不建会话零成本
  'role_enabled.architect': 'on',
  'role_enabled.reviewer': 'on',
  'role_enabled.qa': 'on',
  'role_enabled.challenger': 'on',
  'role_enabled.ba': 'on',
  'role_enabled.devops': 'off',
  'role_enabled.scribe': 'on',
  // 会话回收策略：project_end=项目结束才回收（默认，会话全程保热、prompt 缓存命中、每步更快）；
  // on=每任务结束回收（省单次上下文但每步冷启，慢）；off=永不回收（超长项目慎用，上下文会涨）
  session_recycle: 'project_end',
  // 保热策略下的按量兜底：单轮上下文（input+cache）超过该 token 数的会话在任务间隙自动回收重建；0=关闭
  context_recycle_tokens: '120000',
  // 会议轮数兜底上限：质疑者每轮做收敛裁决，无异议即提前散会；此为防死循环的上限
  meeting_max_rounds: '4',
  // 架构设计环：提案→质疑→修订→再质疑 的循环上限（质疑者放行即提前出环）
  design_max_cycles: '3',
  // 协调者终审：任务过全部质检后、合并前，由协调者对照验收标准做完成度终判
  final_review: 'on',
  // 自测门：dev 提交后系统在其 worktree 真实执行项目 test_cmd，失败不进审查直接打回（省整圈 review→QA 往返）
  selftest_gate: 'on',
  // 集成回归门：任务合并 main 后在 repo 跑全项目 test_cmd，失败自动重开任务修回归（防"后合并破坏先验收"）
  integration_gate: 'on',
  // 最小鉴权：非空后 /api 与 /ws 一律要求 Bearer token（局域网共享前必须设置）；空 = 关闭（仅本机零摩擦）
  auth_token: '',
  // CORS 额外白名单（逗号分隔完整 Origin，如 http://192.168.1.5:5174）；回环地址恒放行
  cors_origins: '',
  // 每角色任务阶段并发数（并发副本会话数）：单 reviewer/qa 是并行开发的咽喉，默认 2 解串行瓶颈；
  // 开发角色默认 1（多任务并行开发可调高，worktree 天然隔离）；coordinator 恒 1（会议/对话/终审需上下文连续）
  'concurrency.frontend': '1',
  'concurrency.backend': '1',
  'concurrency.devops': '1',
  'concurrency.reviewer': '2',
  'concurrency.qa': '2',
  'concurrency.challenger': '1',
  // 审查最多打回次数，超过则升级用户
  max_review_cycles: '3',
  // 同时运行的项目流上限：每个项目十来个子进程会话，无上限会耗尽本机资源；超限的启动请求转暂停等位
  max_concurrent_projects: '2',
  // 质疑者四个介入环节的开关
  challenge_meeting: 'on', // 会议实时打断
  challenge_design: 'on', // 设计文档质疑
  challenge_tasks: 'on', // 任务合并前挑刺
  challenge_approvals: 'on', // 审批参谋意见
  // 单次质疑最大追问轮数（仍不满意则协调者裁决）
  challenge_max_followups: '2',
  // LiteLLM sidecar 配置文件路径（相对仓库根或绝对路径）：有角色的模型指向本机回环代理时平台自动拉起
  litellm_config: 'litellm-config.yaml',
  // 团队工作语言：影响角色 prompt 与所有编排指令/系统消息（zh | en），agent 会话重启后生效
  team_language: 'zh',
  // 审批策略：budget_only = 只有预算/余额类需要人批，其余（危险命令/选型/澄清/打回超限）自动处理并记录；all = 全部升级人批
  approval_policy: 'budget_only',
}

export function getSetting(key: string): string {
  return getSettingRaw(key) ?? SETTING_DEFAULTS[key] ?? ''
}

export function getSettingNumber(key: string): number {
  const n = Number(getSetting(key))
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key] ?? 0)
}

export function updateSettings(patch: Record<string, string>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (k in SETTING_DEFAULTS) setSetting(k, String(v))
  }
}

export function settingsWithDefaults(): Record<string, string> {
  return { ...SETTING_DEFAULTS, ...allSettings() }
}

/** 常驻角色（不可关闭） */
export const CORE_ROLES = ['coordinator', 'frontend', 'backend'] as const

/** 角色是否启用（常驻角色恒 true） */
export function roleEnabled(id: string): boolean {
  if ((CORE_ROLES as readonly string[]).includes(id)) return true
  return getSetting(`role_enabled.${id}`) !== 'off'
}

/** 是否只有预算/余额类审批需要人批（其余自动处理） */
export function budgetOnlyApprovals(): boolean {
  return getSetting('approval_policy') !== 'all'
}

/** 同时运行的项目流上限（1-4） */
export function maxConcurrentProjects(): number {
  const n = Math.floor(getSettingNumber('max_concurrent_projects'))
  if (!Number.isFinite(n) || n < 1) return 2
  return Math.min(n, 4)
}

/** 角色任务阶段并发上限（1-4；未配置的角色如 coordinator 恒 1） */
export function concurrencyFor(id: string): number {
  const n = Math.floor(getSettingNumber(`concurrency.${id}`))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 4)
}
