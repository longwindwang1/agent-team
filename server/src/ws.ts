import type { WebSocket } from 'ws'

const sockets = new Set<WebSocket>()

export function addSocket(socket: WebSocket): void {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
}

export type WsMessageType =
  | 'event' // 审计事件（activity feed）
  | 'message' // 新会议/私聊消息
  | 'agent_status' // agent 状态变化
  | 'task' // 任务创建/流转
  | 'approval' // 新审批请求或审批被决定
  | 'report' // 新报告
  | 'project' // 项目状态变化
  | 'stream' // agent 流式输出片段（不落库，仅实时展示）

export function broadcast(type: WsMessageType, payload: unknown): void {
  const msg = JSON.stringify({ type, payload })
  for (const s of sockets) {
    if (s.readyState === 1) s.send(msg)
  }
}
