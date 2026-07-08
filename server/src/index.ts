import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import './db/index'

// 确保 agent 的 Bash 子进程能找到 node/npm（服务可能由绝对路径 node.exe 启动，PATH 里没有 nodejs 目录）
const nodeDir = path.dirname(process.execPath)
if (!(process.env.PATH ?? '').toLowerCase().includes(nodeDir.toLowerCase())) {
  process.env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`
}
import { registerRoutes } from './routes'
import { addSocket } from './ws'
import { upsertAgent } from './db/dao'
import { getSetting } from './settings'
import { logEvent } from './events'
import { engine } from './orchestrator/engine'
import type { AgentId } from './types'

export const AGENT_DEFS: Array<{ id: AgentId; name: string; role: string }> = [
  { id: 'coordinator', name: '协调者', role: 'PM / 协调者' },
  { id: 'architect', name: '架构师', role: '技术架构师' },
  { id: 'frontend', name: '前端工程师', role: '前端开发' },
  { id: 'backend', name: '后端工程师', role: '后端开发' },
  { id: 'reviewer', name: '审查员', role: '代码审查' },
  { id: 'qa', name: 'QA 工程师', role: '质量保障' },
  { id: 'challenger', name: '质疑者', role: '专职质疑 / 魔鬼代言人' },
  { id: 'ba', name: '需求分析师', role: '需求澄清 / PRD' },
  { id: 'devops', name: 'DevOps 工程师', role: '环境 / 依赖 / CI' },
  { id: 'scribe', name: '书记官', role: '团队记忆提炼' },
]

async function main(): Promise<void> {
  // 落库全部固定角色（model 跟随最新设置刷新）
  for (const def of AGENT_DEFS) {
    upsertAgent(def.id, def.name, def.role, getSetting(`model.${def.id}`))
  }

  // 宿主 shell 残留的 ANTHROPIC_BASE_URL 会把「官方模型」会话也路由到第三方端点（官方路径继承 process.env）
  if (process.env.ANTHROPIC_BASE_URL) {
    logEvent('provider.env_base_url_warning', null, { base_url: process.env.ANTHROPIC_BASE_URL })
  }

  const app = Fastify({ logger: { level: 'info' } })
  await app.register(cors, { origin: true })
  await app.register(websocket)

  app.get('/ws', { websocket: true }, (socket) => {
    addSocket(socket)
  })

  await registerRoutes(app)
  engine.init()

  const port = Number(process.env.PORT ?? 3100)
  await app.listen({ port, host: '127.0.0.1' })
  app.log.info(`server listening on http://127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
