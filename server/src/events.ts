import { addEvent } from './db/dao'
import { broadcast } from './ws'

/** 记录审计事件并实时推送到前端 activity feed */
export function logEvent(type: string, agentId?: string | null, payload?: unknown): void {
  const row = addEvent(type, agentId, payload)
  broadcast('event', row)
}
