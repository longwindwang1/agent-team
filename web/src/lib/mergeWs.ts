import type { Agent, AppState, Approval, EventRow, Project, Report, Task, WsMsg } from './types'

/** 快照内各增长型列表的上限（与 /api/state 服务端上限一致） */
const CAP = { events: 50, approvals: 100, reports: 30 }

/** 按 id upsert 到降序列表头部（已存在则原位替换），并截断上限 */
function upsertDesc<T extends { id: number }>(list: T[], row: T, cap: number): T[] {
  const i = list.findIndex((x) => x.id === row.id)
  if (i >= 0) return list.map((x, j) => (j === i ? row : x))
  return [row, ...list].slice(0, cap)
}

/**
 * WS 消息 → 状态增量合并（纯函数）。
 * 返回新 state = 合并成功；返回 null = 该消息无法安全增量（如切换了活动项目、
 * 出现快照里没有的会议、空 payload 的捅一下事件）→ 调用方回退全量刷新。
 * stream/message 类高频消息由页面订阅者自行消费，这里不动 state 也不触发刷新。
 */
export function applyWs(state: AppState, msg: WsMsg): AppState | null {
  switch (msg.type) {
    case 'stream':
      return state
    case 'message': {
      // 消息本体归订阅者（会议室/对话页）；唯一需要全量的情形：新会议开场（快照的 meetings 里还没有）
      const p = msg.payload as { meeting_id?: number | null }
      if (p?.meeting_id != null && !state.meetings.some((m) => m.id === p.meeting_id)) return null
      return state
    }
    case 'task': {
      const t = msg.payload as Task
      if (typeof t?.id !== 'number') return null
      if (state.project == null || t.project_id !== state.project.id) return state // 他项目任务与本视图无关
      const i = state.tasks.findIndex((x) => x.id === t.id)
      return { ...state, tasks: i >= 0 ? state.tasks.map((x, j) => (j === i ? t : x)) : [...state.tasks, t] }
    }
    case 'approval': {
      const a = msg.payload as Approval
      if (typeof a?.id !== 'number') return null
      return { ...state, approvals: upsertDesc(state.approvals, a, CAP.approvals) }
    }
    case 'report': {
      const r = msg.payload as Report
      if (typeof r?.id !== 'number') return null
      return { ...state, reports: upsertDesc(state.reports, r, CAP.reports) }
    }
    case 'event': {
      const e = msg.payload as EventRow
      if (typeof e?.id !== 'number') return null // 空 payload 的"捅一下"广播 → 全量刷新
      return { ...state, events: upsertDesc(state.events, e, CAP.events) }
    }
    case 'agent_status': {
      const s = msg.payload as { id: Agent['id']; status: string; status_detail: string | null; project_id?: number | null }
      if (!s?.id) return null
      // 只反映活动项目（或无项目上下文）的状态，防并发项目互相覆盖状态栏
      if (s.project_id != null && state.project != null && s.project_id !== state.project.id) return state
      return {
        ...state,
        agents: state.agents.map((a) => (a.id === s.id ? { ...a, status: s.status as Agent['status'], status_detail: s.status_detail } : a)),
      }
    }
    case 'project': {
      const p = msg.payload as Project
      if (typeof p?.id !== 'number') return null
      if (state.project != null && p.id === state.project.id) return { ...state, project: p }
      return null // 非活动项目的变化可能意味着活动指针切换/新项目 → 全量刷新
    }
    case 'settings': {
      const s = msg.payload as Record<string, string>
      if (!s || typeof s !== 'object') return null
      return { ...state, settings: { ...state.settings, ...s } }
    }
    default:
      return null
  }
}
