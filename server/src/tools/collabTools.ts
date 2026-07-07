import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  addMessage,
  createTask,
  currentProject,
  getTask,
  listTasks,
  setTaskStatus,
  updateTask,
} from '../db/dao'
import type { AgentId, TaskStatus } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { ApprovalGate, formatDecision } from '../orchestrator/approvalGate'

const AGENT_IDS = ['coordinator', 'architect', 'frontend', 'backend', 'reviewer', 'qa', 'challenger', 'ba', 'devops', 'scribe'] as const

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] }
}

export interface CollabDeps {
  gate: ApprovalGate
  /** 有 agent 给队友发私信时回调 */
  onDirectMessage?: (from: AgentId, to: AgentId, content: string) => void
  /** 尝试让目标 agent 同步答复私信；不支持时返回 null */
  askAgent?: (from: AgentId, to: AgentId, content: string) => Promise<string | null>
}

/** 每个 agent 一份协作工具（闭包携带自己的身份） */
export function makeCollabServer(agentId: AgentId, deps: CollabDeps) {
  return createSdkMcpServer({
    name: 'collab',
    version: '1.0.0',
    tools: [
      tool(
        'post_to_meeting',
        '在指定会议中发言，所有成员和用户都能看到。仅用于往当前进行中的会议补充重要信息。',
        {
          meeting_id: z.number().int().describe('会议 ID'),
          content: z.string().min(1).describe('发言内容'),
        },
        async (args) => {
          const row = addMessage({ meeting_id: args.meeting_id, from_agent: agentId, content: args.content })
          broadcast('message', row)
          logEvent('meeting.message', agentId, { meeting_id: args.meeting_id })
          return text(`已发送到会议 #${args.meeting_id}`)
        },
      ),
      tool(
        'send_message',
        '给指定队友发一条私信（用于点对点沟通，如向架构师确认接口约定）。',
        {
          to: z.enum(AGENT_IDS).describe('接收者'),
          content: z.string().min(1).describe('私信内容'),
        },
        async (args) => {
          const row = addMessage({ meeting_id: null, from_agent: agentId, to_agent: args.to, content: args.content })
          broadcast('message', row)
          logEvent('dm.sent', agentId, { to: args.to })
          deps.onDirectMessage?.(agentId, args.to as AgentId, args.content)
          // 协调者/架构师可以同步答复
          const reply = await deps.askAgent?.(agentId, args.to as AgentId, args.content)
          if (reply) return text(`${args.to} 回复：\n\n${reply}`)
          return text(`已发送给 ${args.to}（对方暂时无法立即回复，会后续处理）。`)
        },
      ),
      tool(
        'create_task',
        '创建一个开发任务（通常由协调者在会议结论中使用）。',
        {
          title: z.string().min(1).describe('任务标题，动词开头'),
          description: z.string().describe('任务详情，包含验收标准'),
          assignee: z.enum(['frontend', 'backend', 'devops']).describe('负责人'),
        },
        async (args) => {
          const project = currentProject()
          if (!project) return text('错误：当前没有进行中的项目')
          const row = createTask({
            project_id: project.id,
            title: args.title,
            description: args.description,
            assignee: args.assignee as AgentId,
            created_by: agentId,
          })
          broadcast('task', row)
          logEvent('task.created', agentId, { id: row.id, title: row.title, assignee: row.assignee })
          return text(`已创建任务 #${row.id}「${row.title}」，负责人 ${row.assignee}`)
        },
      ),
      tool(
        'update_task',
        '更新任务的备注或状态。开发中的状态流转由系统自动管理，你只在需要补充说明或标记阻塞时使用。',
        {
          task_id: z.number().int().describe('任务 ID'),
          status: z.enum(['in_progress', 'blocked']).optional().describe('可选：新状态（blocked 表示遇到阻塞）'),
          note: z.string().optional().describe('可选：备注说明'),
        },
        async (args) => {
          const task = getTask(args.task_id)
          if (!task) return text(`错误：任务 #${args.task_id} 不存在`)
          const updated = args.status
            ? setTaskStatus(args.task_id, args.status as TaskStatus, args.note)
            : updateTask(args.task_id, args.note !== undefined ? { review_notes: args.note } : {})
          broadcast('task', updated)
          logEvent('task.updated', agentId, { id: args.task_id, status: args.status, note: args.note })
          return text(`任务 #${args.task_id} 已更新`)
        },
      ),
      tool(
        'request_approval',
        '向用户（人类负责人）请求审批一个重要决策。以下情况必须使用：技术栈/架构重大选型、需求范围变更、删除文件等破坏性操作、访问外部网络、安装新依赖、其他你不确定是否越权的事。调用会阻塞，直到用户在审批中心做出决定。',
        {
          title: z.string().min(1).describe('一句话说明要审批什么'),
          context: z.string().describe('背景与理由：为什么需要这个决策、影响是什么'),
          options: z.array(z.string()).min(2).max(5).optional().describe('可选：给用户的选项列表'),
          recommendation: z.string().optional().describe('可选：团队推荐的选项（必须是 options 之一）'),
        },
        async (args) => {
          const project = currentProject()
          const decided = await deps.gate.request({
            project_id: project?.id ?? null,
            requested_by: agentId,
            title: args.title,
            context: args.context,
            options: args.options,
            recommendation: args.recommendation,
          })
          return text(formatDecision(decided))
        },
      ),
      tool(
        'report_blocker',
        '报告你当前工作遇到的阻塞，协调者会安排解决。',
        {
          task_id: z.number().int().optional().describe('相关任务 ID（如有）'),
          reason: z.string().min(1).describe('阻塞原因与已尝试的办法'),
        },
        async (args) => {
          if (args.task_id != null) {
            const t = setTaskStatus(args.task_id, 'blocked', args.reason)
            broadcast('task', t)
          }
          const row = addMessage({ meeting_id: null, from_agent: agentId, to_agent: 'coordinator', content: `[阻塞报告] ${args.reason}` })
          broadcast('message', row)
          logEvent('blocker.reported', agentId, { task_id: args.task_id, reason: args.reason })
          deps.onDirectMessage?.(agentId, 'coordinator', `[阻塞报告] ${args.reason}`)
          return text('已记录阻塞并通知协调者')
        },
      ),
      tool(
        'list_tasks',
        '查看当前项目的任务列表与状态。',
        {},
        async () => {
          const project = currentProject()
          if (!project) return text('当前没有项目')
          const tasks = listTasks(project.id)
          if (tasks.length === 0) return text('还没有任务')
          const lines = tasks.map(
            (t) => `#${t.id} [${t.status}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}${t.review_notes ? ` — ${t.review_notes.slice(0, 80)}` : ''}`,
          )
          return text(lines.join('\n'))
        },
      ),
    ],
  })
}

export const COLLAB_TOOL_NAMES = [
  'mcp__collab__post_to_meeting',
  'mcp__collab__send_message',
  'mcp__collab__create_task',
  'mcp__collab__update_task',
  'mcp__collab__request_approval',
  'mcp__collab__report_blocker',
  'mcp__collab__list_tasks',
]
