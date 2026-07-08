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
  // 任务终结后回收相关 agent 会话（防历史无限增长；记忆管道兜底上下文）
  session_recycle: 'on',
  // 会议最大轮数（防止无限讨论）
  meeting_max_rounds: '2',
  // 审查最多打回次数，超过则升级用户
  max_review_cycles: '3',
  // 质疑者四个介入环节的开关
  challenge_meeting: 'on', // 会议实时打断
  challenge_design: 'on', // 设计文档质疑
  challenge_tasks: 'on', // 任务合并前挑刺
  challenge_approvals: 'on', // 审批参谋意见
  // 单次质疑最大追问轮数（仍不满意则协调者裁决）
  challenge_max_followups: '2',
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
