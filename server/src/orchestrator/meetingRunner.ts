import { closeMeeting, createMeeting, createTask, getMeetingProjectId, getTask, listMessages, updateTask } from '../db/dao'
import { findCycleIds, mapOrdinalsToIds } from '../lib/deps'
import type { AgentId, MeetingRow, ProjectRow, TaskRow } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { getSetting, getSettingNumber, roleEnabled } from '../settings'
import type { AgentPool } from './agentPool'
import { postMessage } from './engine'
import { archiveLesson, globalLessonsSection } from './memory'
import { agentLabel, tx } from './texts'

/** 每场会议质疑者最多打断次数（防止会议被卡死） */
const MAX_INTERRUPTS_PER_MEETING = 6

/** 从回复中提取 ```json ... ``` 代码块并解析 */
export function parseJsonBlock<T>(text: string): T | null {
  const match = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  try {
    return JSON.parse(raw.trim()) as T
  } catch {
    // 尝试截取第一个 { 到最后一个 }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

interface KickoffResult {
  meeting: MeetingRow
  tasks: TaskRow[]
  summary: string
}

export class MeetingRunner {
  /** agent → 已看过的最后一条消息 id（按会议隔离） */
  private lastSeen = new Map<string, number>()

  constructor(private readonly pool: AgentPool) {}

  private seenKey(meetingId: number, agent: AgentId): string {
    return `${meetingId}:${agent}`
  }

  /** 取该 agent 尚未看过的会议消息（并标记已看） */
  private transcriptDelta(meetingId: number, agent: AgentId): string {
    const key = this.seenKey(meetingId, agent)
    const seen = this.lastSeen.get(key) ?? 0
    const fresh = listMessages(meetingId).filter((m) => m.id > seen && m.from_agent !== agent)
    const all = listMessages(meetingId)
    if (all.length > 0) this.lastSeen.set(key, all[all.length - 1].id)
    return fresh.map((m) => `【${agentLabel(m.from_agent)}】\n${m.content}`).join('\n\n---\n\n')
  }

  /** 会议内提问但不落发言（用于质疑者的静默检查/评判回合） */
  private async askInMeeting(agent: AgentId, meetingId: number, instruction: string, statusDetail: string): Promise<string> {
    const delta = this.transcriptDelta(meetingId, agent)
    const prompt = delta ? `${tx().transcriptIntro(meetingId, delta)}${instruction}` : instruction
    return this.pool.ask(agent, prompt, { meetingId, statusDetail })
  }

  /** 让 agent 在会议中发言：把未读记录 + 指令发给它，回复写入会议 */
  private async speak(agent: AgentId, meetingId: number, instruction: string, statusDetail: string): Promise<string> {
    const reply = await this.askInMeeting(agent, meetingId, instruction, statusDetail)
    const row = postMessage(meetingId, agent, reply)
    this.lastSeen.set(this.seenKey(meetingId, agent), row.id)
    return reply
  }

  /** 质疑者发言（打断/追问/解除），并标记已读 */
  private challengerSay(meetingId: number, content: string): void {
    const row = postMessage(meetingId, 'challenger', content)
    this.lastSeen.set(this.seenKey(meetingId, 'challenger'), row.id)
  }

  private challengerAvailable(): boolean {
    return getSetting('challenge_meeting') === 'on' && roleEnabled('challenger') && this.pool.has('challenger')
  }

  /**
   * 质疑检查点（单人版，用于协调者开场/总结）：发言后质疑者判断是否打断。
   * 打断 → 被质疑者必须正面回答 → 质疑者评判 → 满意才放行（追问超限则协调者裁决）。
   * 返回是否发生过打断。
   */
  private async challengeCheckpoint(meetingId: number, speaker: AgentId, interrupts: { count: number }): Promise<boolean> {
    if (!this.challengerAvailable() || speaker === 'challenger') return false
    if (interrupts.count >= MAX_INTERRUPTS_PER_MEETING) return false

    const t = tx()
    const checkReply = await this.askInMeeting('challenger', meetingId, t.challengeCheck(agentLabel(speaker)), t.stListening)
    const check = parseJsonBlock<{ pass?: boolean; challenge?: string }>(checkReply)
    if (!check || check.pass !== false || !check.challenge?.trim()) return false

    return this.runInterruptLoop(meetingId, speaker, check.challenge, interrupts)
  }

  /**
   * 质疑检查点（按轮批量版，用于参会者轮次）：一轮结束后质疑者一次性检查全部新发言，
   * 可指定质疑对象（省 token：N 人一轮只花一次检查回合）。
   */
  private async challengeCheckpointRound(meetingId: number, speakers: AgentId[], interrupts: { count: number }): Promise<boolean> {
    if (!this.challengerAvailable() || speakers.length === 0) return false
    if (interrupts.count >= MAX_INTERRUPTS_PER_MEETING) return false

    const t = tx()
    const checkReply = await this.askInMeeting(
      'challenger',
      meetingId,
      t.challengeCheckRound(speakers.map((s) => `${s}(${agentLabel(s)})`).join(', ')),
      t.stListening,
    )
    const check = parseJsonBlock<{ pass?: boolean; to?: string; challenge?: string }>(checkReply)
    if (!check || check.pass !== false || !check.challenge?.trim()) return false
    const target = (speakers.includes(check.to as AgentId) ? check.to : speakers[speakers.length - 1]) as AgentId

    return this.runInterruptLoop(meetingId, target, check.challenge, interrupts)
  }

  /** 打断-回答-评判-追问循环（僵持则协调者裁决） */
  private async runInterruptLoop(meetingId: number, speaker: AgentId, challenge: string, interrupts: { count: number }): Promise<boolean> {
    const t = tx()
    interrupts.count++
    logEvent('challenge.interrupt', 'challenger', { meeting_id: meetingId, target: speaker })
    this.challengerSay(meetingId, t.interruptMsg(agentLabel(speaker), challenge.trim()))

    const maxFollowups = Math.max(0, getSettingNumber('challenge_max_followups'))
    for (let round = 0; ; round++) {
      await this.speak(speaker, meetingId, t.challengeAnswer(), t.stRespondChallenge)
      const evalReply = await this.askInMeeting('challenger', meetingId, t.challengeEval(), t.stJudging)
      const verdict = parseJsonBlock<{ satisfied?: boolean; comment?: string; followup?: string }>(evalReply)
      if (!verdict || verdict.satisfied !== false) {
        this.challengerSay(meetingId, t.resolvedMsg(verdict?.comment))
        logEvent('challenge.resolved', 'challenger', { meeting_id: meetingId, target: speaker, rounds: round + 1 })
        return true
      }
      if (round >= maxFollowups) {
        // 僵持 → 协调者当场裁决（裁决归档进团队记忆）
        this.challengerSay(meetingId, t.deadlockMsg(verdict.followup))
        const ruling = await this.speak('coordinator', meetingId, t.adjudicate(agentLabel(speaker)), t.stAdjudicating)
        archiveLesson({
          project_id: getMeetingProjectId(meetingId),
          source_type: 'meeting',
          source_id: meetingId,
          tags: speaker,
          content: ruling.slice(0, 800),
          created_by: 'coordinator',
        })
        logEvent('challenge.adjudicated', 'coordinator', { meeting_id: meetingId, target: speaker })
        return true
      }
      this.challengerSay(meetingId, t.followupMsg(verdict.followup))
    }
  }

  /** kickoff 会议：开场 → 轮流发言（每轮末批量质疑检查）→ 总结 + 任务清单；prd 提供时以 PRD 为纲 */
  async runKickoff(project: ProjectRow, prd?: string): Promise<KickoffResult> {
    const t = tx()
    const meeting = createMeeting(project.id, 'kickoff', t.meetingTopic(project.name))
    logEvent('meeting.started', 'coordinator', { id: meeting.id, topic: meeting.topic })
    postMessage(meeting.id, 'system', prd ? t.prdAnnouncement(prd) : t.meetingAnnouncement(project.requirement))

    // 质疑者打断计数（每场会议共享上限）
    const interrupts = { count: 0 }

    // 1. 协调者开场（附全局团队记忆）
    await this.speak('coordinator', meeting.id, t.kickoffOpening(project.name) + globalLessonsSection(5), t.stChairing)
    await this.challengeCheckpoint(meeting.id, 'coordinator', interrupts)

    // 2. 参会者轮流发言（按启用状态组队；每轮结束质疑者一次批量检查，可打断任意发言人）
    const participants: Array<{ id: AgentId; focus: string }> = (
      [
        { id: 'architect' as AgentId, focus: t.focusArchitect },
        { id: 'frontend' as AgentId, focus: t.focusFrontend },
        { id: 'backend' as AgentId, focus: t.focusBackend },
        { id: 'devops' as AgentId, focus: t.focusDevops },
        { id: 'qa' as AgentId, focus: t.focusQa },
      ] as Array<{ id: AgentId; focus: string }>
    ).filter((p) => roleEnabled(p.id))
    const maxRounds = Math.max(1, getSettingNumber('meeting_max_rounds'))
    for (let round = 1; round <= maxRounds; round++) {
      const spoke: AgentId[] = []
      for (const p of participants) {
        const said = await this.speak(
          p.id,
          meeting.id,
          round === 1 ? t.participantTurnFirst(p.focus) : t.participantTurnLater(round),
          t.stAttending(round),
        )
        if (!t.passSentinel.test(said.trim())) spoke.push(p.id)
      }
      if (spoke.length === 0) break
      await this.challengeCheckpointRound(meeting.id, spoke, interrupts)
    }

    // 3. 协调者总结 + 任务清单（JSON）
    let closing = await this.speak('coordinator', meeting.id, t.kickoffClosing(), t.stClosing)

    // 总结同样接受质疑；被打断过则要求协调者输出修订版（任务建立以修订版为准）
    const summaryChallenged = await this.challengeCheckpoint(meeting.id, 'coordinator', interrupts)
    if (summaryChallenged) {
      closing = await this.speak('coordinator', meeting.id, t.kickoffRevision(), t.stRevising)
    }

    interface KickoffTaskItem {
      title: string
      description: string
      assignee: string
      depends_on?: unknown
      owns_files?: unknown
    }
    let parsed = parseJsonBlock<{ summary?: string; tasks?: Array<KickoffTaskItem> }>(closing)
    // 任务拆分是全平台唯一硬失败点：解析失败自动带格式要求重问一次（弱模型兜底），仍失败才走上层报错
    if (!parsed?.tasks?.length) {
      logEvent('json.retry', 'coordinator', { where: 'kickoff' })
      closing = await this.speak('coordinator', meeting.id, t.jsonRetry(), t.stClosing)
      parsed = parseJsonBlock<{ summary?: string; tasks?: Array<KickoffTaskItem> }>(closing) ?? parsed
    }
    const summary = parsed?.summary ?? closing.slice(0, 200)
    const items = parsed?.tasks ?? []

    // 第一遍：按原数组下标建任务（被跳过的无 title 项也占序号，防 depends_on 错位）
    const tasks: TaskRow[] = []
    const ordinalToId: Array<number | null> = []
    for (const item of items) {
      if (!item?.title) {
        ordinalToId.push(null)
        continue
      }
      const valid = ['frontend', 'backend', ...(roleEnabled('devops') ? ['devops'] : [])]
      const assignee: AgentId = (valid.includes(item.assignee) ? item.assignee : 'backend') as AgentId
      const ownsFiles = Array.isArray(item.owns_files) ? item.owns_files.filter((f): f is string => typeof f === 'string' && !!f.trim()) : []
      const row = createTask({
        project_id: project.id,
        title: item.title,
        description: item.description ?? '',
        assignee,
        created_by: 'coordinator',
        owns_files: ownsFiles,
      })
      tasks.push(row)
      ordinalToId.push(row.id)
    }

    // 第二遍：depends_on 序号 → 真实 id（非法引用丢弃并告警），随后破环防死锁
    for (let i = 0; i < items.length; i++) {
      const id = ordinalToId[i]
      if (id == null || !items[i]?.depends_on) continue
      const { ids, invalid } = mapOrdinalsToIds(items[i].depends_on, i + 1, ordinalToId)
      if (invalid.length > 0) logEvent('task.deps_invalid', 'coordinator', { task: id, invalid })
      if (ids.length > 0) updateTask(id, { deps: JSON.stringify(ids) })
    }
    const cycleIds = findCycleIds(tasks.map((row) => getTask(row.id)!))
    for (const cid of cycleIds) {
      updateTask(cid, { deps: '[]' })
      logEvent('task.deps_cycle', 'coordinator', { task: cid })
    }
    for (let i = 0; i < tasks.length; i++) {
      const final = getTask(tasks[i].id)!
      tasks[i] = final
      broadcast('task', final)
      logEvent('task.created', 'coordinator', { id: final.id, title: final.title, assignee: final.assignee, deps: final.deps })
    }

    closeMeeting(meeting.id, summary)
    logEvent('meeting.closed', 'coordinator', { id: meeting.id, summary, tasks: tasks.length })
    broadcast('event', {})
    return { meeting, tasks, summary }
  }

  /** 临时站会：把阻塞或分歧摆到桌面上，协调者给出裁决 */
  async runStandup(project: ProjectRow, topic: string, context: string): Promise<string> {
    const t = tx()
    const meeting = createMeeting(project.id, 'standup', topic)
    logEvent('meeting.started', 'coordinator', { id: meeting.id, topic })
    postMessage(meeting.id, 'system', t.standupSystem(context))
    const decision = await this.speak('coordinator', meeting.id, t.standupInstruction(), t.stStandup)
    closeMeeting(meeting.id, decision.slice(0, 200))
    return decision
  }
}
