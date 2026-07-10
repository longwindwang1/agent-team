import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 防真弹 Windows 桌面通知
vi.mock('node-notifier', () => ({ default: { notify: vi.fn() } }))

import { closeDb, initDb } from '../src/db/index'
import { decideApproval, pendingApprovals, setSetting } from '../src/db/dao'
import { ApprovalGate } from '../src/orchestrator/approvalGate'
import { tx } from '../src/orchestrator/texts'

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(() => {
  initDb(':memory:')
})
afterAll(() => closeDb())

describe('ApprovalGate', () => {
  it('budget_only 策略下 decision 类自动批：按推荐项落库 + 不产生 pending', async () => {
    setSetting('approval_policy', 'budget_only')
    const gate = new ApprovalGate()
    const row = await gate.request({ requested_by: 'architect', title: '选型：要不要引入 lodash', options: ['要', '不要'], recommendation: '不要', kind: 'decision' })
    expect(row.status).toBe('approved')
    expect(row.decision).toBe('不要')
    expect(row.comment).toBe(tx().autoApprovedNote)
    expect(gate.hasPending()).toBe(false)
  })

  it('budget 类永远升级人批：pending 往返（decideApproval + resolve）', async () => {
    setSetting('approval_policy', 'budget_only')
    const gate = new ApprovalGate()
    const p = gate.request({ requested_by: 'coordinator', title: '预算超了要加钱', kind: 'budget' })
    await until(() => pendingApprovals().some((a) => a.title === '预算超了要加钱'))
    expect(gate.hasPendingFor('coordinator')).toBe(true)
    const pending = pendingApprovals().find((a) => a.title === '预算超了要加钱')!
    const decided = decideApproval(pending.id, 'approved', '追加 $5', '批了')!
    gate.resolve(decided)
    const row = await p
    expect(row.status).toBe('approved')
    expect(row.decision).toBe('追加 $5')
    expect(gate.hasPendingFor('coordinator')).toBe(false)
    expect(gate.hasPending()).toBe(false)
  })

  it('approval_policy=all 时 decision 类也走人批', async () => {
    setSetting('approval_policy', 'all')
    const gate = new ApprovalGate()
    const p = gate.request({ requested_by: 'backend', title: '装依赖 axios', kind: 'decision' })
    await until(() => pendingApprovals().some((a) => a.title === '装依赖 axios'))
    const pending = pendingApprovals().find((a) => a.title === '装依赖 axios')!
    gate.resolve(decideApproval(pending.id, 'rejected', undefined, '用内置 fetch')!)
    const row = await p
    expect(row.status).toBe('rejected')
    setSetting('approval_policy', 'budget_only')
  })

  it('参谋意见拼进 context（opinionSeparator 分隔）', async () => {
    setSetting('approval_policy', 'all')
    const gate = new ApprovalGate()
    gate.adviser = async () => '质疑者认为：没必要'
    const p = gate.request({ requested_by: 'backend', title: '带参谋的审批', context: '原始上下文', kind: 'decision' })
    await until(() => pendingApprovals().some((a) => a.title === '带参谋的审批'))
    const pending = pendingApprovals().find((a) => a.title === '带参谋的审批')!
    expect(pending.context).toContain('原始上下文')
    expect(pending.context).toContain(tx().opinionSeparator)
    expect(pending.context).toContain('质疑者认为：没必要')
    gate.resolve(decideApproval(pending.id, 'approved')!)
    await p
    setSetting('approval_policy', 'budget_only')
  })
})
