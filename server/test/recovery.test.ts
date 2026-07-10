import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, initDb } from '../src/db/index'
import { closeMeeting, createApproval, createMeeting, createProject, decideApproval, getApproval, listMeetings, pendingApprovals } from '../src/db/dao'
import { expireStaleApprovals, sweepOpenMeetings } from '../src/orchestrator/recovery'
import { tx } from '../src/orchestrator/texts'

beforeAll(() => initDb(':memory:'))
afterAll(() => closeDb())

describe('崩溃恢复清扫', () => {
  it('sweepOpenMeetings 只作废本项目的 open 会议，closed 与他项目不动', () => {
    const p1 = createProject('P1', 'r', 10)
    const p2 = createProject('P2', 'r', 10)
    const open1 = createMeeting(p1.id, 'kickoff', 'P1 kickoff（崩溃遗留）')
    const open2 = createMeeting(p1.id, 'standup', 'P1 站会（崩溃遗留）')
    const closed1 = createMeeting(p1.id, 'kickoff', 'P1 已收尾')
    const other = createMeeting(p2.id, 'kickoff', 'P2 open 不该被扫')
    closeMeeting(closed1.id, '正常纪要')

    const swept = sweepOpenMeetings(p1.id)
    expect(swept).toBe(2)
    const p1Meetings = listMeetings(p1.id)
    expect(p1Meetings.every((m) => m.status === 'closed')).toBe(true)
    expect(p1Meetings.find((m) => m.id === open1.id)!.summary).toBe(tx().meetingSweptSummary)
    expect(p1Meetings.find((m) => m.id === open2.id)!.summary).toBe(tx().meetingSweptSummary)
    expect(p1Meetings.find((m) => m.id === closed1.id)!.summary).toBe('正常纪要') // 已收尾的不被覆盖
    expect(listMeetings(p2.id).find((m) => m.id === other.id)!.status).toBe('open') // 他项目不动
    // 幂等：再扫为 0
    expect(sweepOpenMeetings(p1.id)).toBe(0)
  })

  it('expireStaleApprovals 只过期 pending（带失效说明），已决的不动', () => {
    const a1 = createApproval({ requested_by: 'coordinator', title: '崩溃前的预算审批', kind: 'budget' })
    const a2 = createApproval({ requested_by: 'backend', title: '崩溃前的返工审批', kind: 'rework' })
    const done = createApproval({ requested_by: 'architect', title: '早已批过的', kind: 'decision' })
    decideApproval(done.id, 'approved', '选 A', '早批了')

    const expired = expireStaleApprovals()
    expect(expired).toBe(2)
    expect(pendingApprovals()).toHaveLength(0)
    const r1 = getApproval(a1.id)!
    expect(r1.status).toBe('rejected')
    expect(r1.comment).toBe(tx().approvalExpiredComment)
    expect(getApproval(a2.id)!.status).toBe('rejected')
    expect(getApproval(done.id)!.comment).toBe('早批了') // 已决行原样
    // 幂等
    expect(expireStaleApprovals()).toBe(0)
  })
})
