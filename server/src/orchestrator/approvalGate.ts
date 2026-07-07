import notifier from 'node-notifier'
import { createApproval } from '../db/dao'
import type { ApprovalRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { tx } from './texts'

export interface ApprovalRequest {
  project_id?: number | null
  requested_by: string
  title: string
  context?: string
  options?: string[]
  recommendation?: string
}

/**
 * 审批门：agent 发起审批 → 前端弹卡片 + 桌面通知 → 阻塞等待用户决定。
 * 用户在前端做出决定后，routes 调用 engine.onApprovalDecided → resolve()。
 */
export class ApprovalGate {
  private resolvers = new Map<number, (row: ApprovalRow) => void>()
  private pendingByAgent = new Map<string, number>()

  /** 审批参谋：落卡前征询质疑者意见，附加到 context（超时/失败静默跳过） */
  adviser: ((input: ApprovalRequest) => Promise<string | null>) | null = null

  /** 发起审批并阻塞等待结果 */
  async request(input: ApprovalRequest): Promise<ApprovalRow> {
    if (this.adviser && input.requested_by !== 'challenger') {
      const opinion = await this.adviser(input).catch(() => null)
      if (opinion?.trim()) {
        input = { ...input, context: `${input.context ?? ''}\n\n${tx().opinionSeparator}\n${opinion.trim()}` }
      }
    }
    const row = createApproval(input)
    logEvent('approval.requested', input.requested_by, { id: row.id, title: row.title })
    broadcast('approval', row)
    this.notifyDesktop(row)
    this.pendingByAgent.set(input.requested_by, (this.pendingByAgent.get(input.requested_by) ?? 0) + 1)
    return new Promise<ApprovalRow>((resolve) => {
      this.resolvers.set(row.id, resolve)
    })
  }

  /** 用户已决定（approved / rejected） */
  resolve(row: ApprovalRow): void {
    const r = this.resolvers.get(row.id)
    if (r) {
      this.resolvers.delete(row.id)
      const n = this.pendingByAgent.get(row.requested_by) ?? 0
      if (n <= 1) this.pendingByAgent.delete(row.requested_by)
      else this.pendingByAgent.set(row.requested_by, n - 1)
      r(row)
    }
  }

  hasPending(): boolean {
    return this.resolvers.size > 0
  }

  /** 该 agent 是否有未决审批（等待期间不计入无活动超时） */
  hasPendingFor(agentId: string): boolean {
    return (this.pendingByAgent.get(agentId) ?? 0) > 0
  }

  private notifyDesktop(row: ApprovalRow): void {
    try {
      notifier.notify({
        title: tx().notifyApprovalTitle,
        message: row.title,
        appID: 'Agent Team',
      })
    } catch {
      // 桌面通知失败不影响主流程
    }
  }
}

export function formatDecision(row: ApprovalRow): string {
  if (row.status === 'approved') {
    return `用户已批准${row.decision ? `，选择：「${row.decision}」` : ''}${row.comment ? `。用户意见：${row.comment}` : ''}`
  }
  return `用户驳回了该请求${row.comment ? `，原因：${row.comment}` : ''}。请调整方案，必要时重新发起审批。`
}
