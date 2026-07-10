import { closeMeeting, decideApproval, listMeetings, pendingApprovals } from '../db/dao'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { tx } from './texts'

/**
 * 崩溃恢复清扫（纯 dao/events 依赖，可脱离 engine/SDK 单测）：
 * 服务中断会留下两类孤儿——open 会议（内存 lastSeen 已丢，无法续开）与 pending 审批
 * （resolvers Promise 已随进程消亡，没人在等）。启动/续跑时显式清掉，防重复开会与重复审批卡片。
 */

/** 作废该项目遗留的 open 会议（会议不做断点续传：作废后 kickoff 照旧按 tasks.length===0 重开） */
export function sweepOpenMeetings(projectId: number): number {
  let swept = 0
  for (const m of listMeetings(projectId)) {
    if (m.status !== 'open') continue
    closeMeeting(m.id, tx().meetingSweptSummary)
    logEvent('meeting.swept', null, { id: m.id, project_id: projectId, topic: m.topic })
    swept++
  }
  return swept
}

/** 过期全部 pending 审批（新进程 resolvers 为空、原等待方已消亡；重跑的阶段会重新发起） */
export function expireStaleApprovals(): number {
  let expired = 0
  for (const a of pendingApprovals()) {
    const row = decideApproval(a.id, 'rejected', undefined, tx().approvalExpiredComment)
    if (!row) continue
    broadcast('approval', row)
    logEvent('approval.expired', null, { id: a.id, title: a.title, requested_by: a.requested_by })
    expired++
  }
  return expired
}
