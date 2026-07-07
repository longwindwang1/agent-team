import { allSettings, getSettingRaw, setSetting } from './db/dao'

export const SETTING_DEFAULTS: Record<string, string> = {
  // 汇报周期：cron 表达式；test 模式下用每 2 分钟便于验证
  report_cron: '0 */2 * * *',
  report_test_mode: 'off', // off | fast(每2分钟)
  // 预算（美元），超出后熔断并请求用户审批
  budget_usd: '10',
  // 各角色模型（默认全部 claude-opus-4-8，可在设置页调整）
  'model.coordinator': 'claude-opus-4-8',
  'model.architect': 'claude-opus-4-8',
  'model.frontend': 'claude-opus-4-8',
  'model.backend': 'claude-opus-4-8',
  'model.reviewer': 'claude-opus-4-8',
  'model.qa': 'claude-opus-4-8',
  'model.challenger': 'claude-opus-4-8',
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
