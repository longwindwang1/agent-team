import path from 'node:path'
import { query, type Options, type PermissionResult, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../lib/asyncQueue'
import { addUsage, getProvider, listProviders, setAgentModel, setAgentSession, setAgentStatus } from '../db/dao'
import type { AgentId } from '../types'
import { logEvent } from '../events'
import { broadcast } from '../ws'
import { getSetting } from '../settings'
import { buildProviderEnv, computeCostUsd, parseModels, resolveModelSpec, DEFAULT_MODEL } from '../providers'
import { makeCollabServer, COLLAB_TOOL_NAMES, type CollabDeps } from '../tools/collabTools'
import { ApprovalGate } from './approvalGate'
import { tx } from './texts'

const READ_TOOLS = ['Read', 'Glob', 'Grep']
const NO_WEB = ['WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit']

const ROLE_TOOLS: Record<AgentId, { allowed: string[]; disallowed: string[] }> = {
  coordinator: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: ['Write', 'Edit', 'MultiEdit', 'Bash', ...NO_WEB],
  },
  architect: {
    allowed: [...READ_TOOLS, 'Write', ...COLLAB_TOOL_NAMES],
    disallowed: ['Bash', ...NO_WEB],
  },
  frontend: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: [...NO_WEB],
  },
  backend: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: [...NO_WEB],
  },
  reviewer: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: ['Write', 'Edit', 'MultiEdit', ...NO_WEB],
  },
  qa: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: ['Write', 'Edit', 'MultiEdit', ...NO_WEB],
  },
  challenger: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: ['Write', 'Edit', 'MultiEdit', 'Bash', ...NO_WEB],
  },
  ba: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: ['Write', 'Edit', 'MultiEdit', 'Bash', ...NO_WEB],
  },
  devops: {
    allowed: [...READ_TOOLS, ...COLLAB_TOOL_NAMES],
    disallowed: [...NO_WEB],
  },
  scribe: {
    allowed: [...READ_TOOLS, 'mcp__collab__list_tasks'],
    disallowed: ['Write', 'Edit', 'MultiEdit', 'Bash', ...NO_WEB],
  },
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORT_LEVELS)[number]

function effortFor(id: AgentId): Effort {
  const v = getSetting(`effort.${id}`)
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as Effort) : 'medium'
}

import { classifyBash } from './policies'

export interface AskOptions {
  meetingId?: number | null
  /** 无活动超时（有工具调用/输出即刷新），默认 20 分钟 */
  timeoutMs?: number
  /** 状态栏展示 */
  statusDetail?: string
}

interface Pending {
  resolve: (text: string) => void
  reject: (err: Error) => void
  lastText: string
}

export class AgentSession {
  private queue = new AsyncQueue<SDKUserMessage>()
  private q: Query
  private pending: Pending | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private meetingContext: number | null = null
  private activityTimer: ReturnType<typeof setTimeout> | null = null
  private timeoutMs = 20 * 60_000
  /** >0 时表示正在等用户审批，超时计时暂停 */
  pausedForApproval = 0
  closed = false
  /** 进行中 + 排队中的 ask 数（回收前的忙碌判断） */
  private activeOps = 0
  /** 第三方模型不在价格表时只警告一次 */
  private warnedNoPricing = false

  get isBusy(): boolean {
    return this.activeOps > 0
  }

  constructor(
    readonly id: AgentId,
    private readonly cfg: {
      cwd: string
      systemPrompt: string
      /** 传给 SDK 的模型名（第三方时是端点侧的 modelId） */
      model: string
      /** 原始 settings 值（如 deepseek/deepseek-v4-flash），用于展示与 usage 归档 */
      modelLabel: string
      /** 第三方端点的会话环境变量；官方路径不传（继承 process.env，兼容订阅登录） */
      env?: Record<string, string | undefined>
      /** 第三方端点对 effort 字段容忍度不一，仅 supports_effort 的模型才传 */
      includeEffort: boolean
      /** 第三方 provider id；记账时实时查价用 */
      providerId?: string
      gate: ApprovalGate
      collabDeps: CollabDeps
      resumeSessionId?: string
    },
  ) {
    const roleTools = ROLE_TOOLS[id]
    const options: Options = {
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      cwd: cfg.cwd,
      ...(cfg.includeEffort ? { effort: effortFor(id) } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
      allowedTools: roleTools.allowed,
      disallowedTools: roleTools.disallowed,
      permissionMode: 'default',
      canUseTool: (toolName, input, { signal }) => this.canUseTool(toolName, input, signal),
      mcpServers: { collab: makeCollabServer(id, cfg.collabDeps) },
      includePartialMessages: true,
      settingSources: [],
      ...(cfg.resumeSessionId ? { resume: cfg.resumeSessionId } : {}),
    }
    this.q = query({ prompt: this.queue, options })
    void this.consume()
  }

  /** 提问并等待本轮结束（同一 agent 的多次 ask 自动串行） */
  ask(prompt: string, opts: AskOptions = {}): Promise<string> {
    const run = () => this.runTurn(prompt, opts)
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    this.activeOps++
    return result.finally(() => {
      this.activeOps--
    })
  }

  private async runTurn(prompt: string, opts: AskOptions): Promise<string> {
    if (this.closed) throw new Error(`${this.id} 会话已关闭`)
    this.meetingContext = opts.meetingId ?? null
    this.timeoutMs = opts.timeoutMs ?? 20 * 60_000
    this.setStatus('thinking', opts.statusDetail)
    const turn = new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject, lastText: '' }
    })
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as unknown as SDKUserMessage)
    this.touch()
    try {
      return await turn
    } finally {
      this.clearTimer()
      this.pending = null
      this.meetingContext = null
      this.setStatus('idle')
    }
  }

  /** 无活动超时：每次收到 SDK 消息都重置；等审批时不计时 */
  private touch(): void {
    this.clearTimer()
    this.activityTimer = setTimeout(() => {
      if (this.pausedForApproval > 0 || this.cfg.gate.hasPendingFor(this.id)) {
        this.touch() // 审批等待中，继续等
        return
      }
      if (this.pending) {
        const err = new Error(`${this.id} 超过 ${Math.round(this.timeoutMs / 60000)} 分钟无响应，已中断本轮`)
        this.pending.reject(err)
        this.pending = null
        void this.q.interrupt().catch(() => {})
        this.setStatus('error', err.message)
      }
    }, this.timeoutMs)
  }

  private clearTimer(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = null
  }

  private setStatus(status: 'idle' | 'thinking' | 'working' | 'waiting_approval' | 'error', detail?: string): void {
    setAgentStatus(this.id, status, detail)
    broadcast('agent_status', { id: this.id, status, status_detail: detail ?? null })
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.q) {
        this.touch()
        const m = msg as Record<string, unknown>
        switch (m.type) {
          case 'system': {
            if (m.subtype === 'init' && typeof m.session_id === 'string') {
              setAgentSession(this.id, m.session_id)
            }
            break
          }
          case 'stream_event': {
            const event = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
            if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              broadcast('stream', { agent_id: this.id, text: event.delta.text, meeting_id: this.meetingContext })
            }
            break
          }
          case 'assistant': {
            const message = m.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
            const blocks = message?.content ?? []
            const texts = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text as string)
            if (texts.length > 0 && this.pending) this.pending.lastText = texts.join('\n')
            for (const b of blocks) {
              if (b.type === 'tool_use' && b.name) {
                this.setStatus('working', tx().stToolUse(b.name))
                logEvent('agent.tool_use', this.id, { tool: b.name })
              }
            }
            break
          }
          case 'result': {
            const usage = (m.usage ?? {}) as Record<string, number>
            const tokens = {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
              cache_read_tokens: usage.cache_read_input_tokens ?? 0,
              cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
            }
            // 官方：SDK 报的 total_cost_usd 可信；第三方：端点乱报/报 0，按价格表自算（实时查价，调价即时生效）
            let costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0
            if (this.cfg.providerId) {
              const provider = getProvider(this.cfg.providerId)
              const pricing = provider ? (parseModels(provider.models_json).find((x) => x.id === this.cfg.model) ?? null) : null
              costUsd = computeCostUsd(tokens, pricing)
              if (!pricing && !this.warnedNoPricing) {
                this.warnedNoPricing = true
                logEvent('provider.no_pricing', this.id, { model: this.cfg.modelLabel })
              }
            }
            addUsage({ agent_id: this.id, ...tokens, cost_usd: costUsd, model: this.cfg.modelLabel })
            if (this.pending) {
              if (m.subtype === 'success' && m.is_error !== true) {
                const finalText = typeof m.result === 'string' && m.result.trim() ? m.result : this.pending.lastText
                this.pending.resolve(finalText)
              } else {
                this.pending.reject(new Error(`${this.id} 本轮执行失败 (${String(m.subtype)})${typeof m.result === 'string' ? `: ${m.result.slice(0, 300)}` : ''}`))
              }
            }
            break
          }
          default:
            break
        }
      }
      // 输入队列关闭 → 会话自然结束
      if (this.pending) this.pending.reject(new Error(`${this.id} 会话已结束`))
    } catch (err) {
      const e = err as Error
      this.setStatus('error', e.message.slice(0, 200))
      logEvent('agent.error', this.id, { error: e.message.slice(0, 500) })
      this.pending?.reject(e)
      this.pending = null
    }
  }

  /** 动态权限门：路径约束 + 危险命令 → 用户审批 */
  private async canUseTool(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    // 文件写入类：限制在项目工作区内
    if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      const resolved = path.resolve(this.cfg.cwd, filePath)
      if (!resolved.startsWith(path.resolve(this.cfg.cwd))) {
        return { behavior: 'deny', message: tx().denyOutsideWorkspace(this.cfg.cwd) }
      }
      return { behavior: 'allow', updatedInput: input }
    }

    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      const needsApproval = classifyBash(cmd)
      if (needsApproval) {
        return this.requestBashApproval(cmd, needsApproval.label, signal)
      }
      return { behavior: 'allow', updatedInput: input }
    }

    // 其余工具默认放行（allowedTools/disallowedTools 已做静态约束）
    return { behavior: 'allow', updatedInput: input }
  }

  private async requestBashApproval(cmd: string, zhLabel: string, signal: AbortSignal): Promise<PermissionResult> {
    const t = tx()
    const label = t.bashLabel(zhLabel)
    this.pausedForApproval++
    this.setStatus('waiting_approval', t.stWaitApproval(label))
    try {
      const decided = await this.cfg.gate.request({
        requested_by: this.id,
        title: t.bashApprovalTitle(label),
        context: t.bashApprovalContext(this.id, cmd, label),
      })
      if (signal.aborted) return { behavior: 'deny', message: 'interrupted' }
      if (decided.status === 'approved') {
        return { behavior: 'allow', updatedInput: { command: cmd } }
      }
      return { behavior: 'deny', message: t.denyByUser(label, decided.comment) }
    } finally {
      this.pausedForApproval--
      this.setStatus('working')
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearTimer()
    this.queue.close()
    await this.q.interrupt().catch(() => {})
  }
}

/** 管理各角色会话的池子（支持任务后回收 + 按需懒重建） */
export class AgentPool {
  private sessions = new Map<AgentId, AgentSession>()
  /** startAgents 记录的项目上下文，用于回收后按需懒重建 */
  private projectCwd: string | null = null

  constructor(
    private readonly gate: ApprovalGate,
    private readonly promptLoader: (id: AgentId) => string,
    private readonly collabDeps: CollabDeps,
  ) {}

  private createSession(id: AgentId, cwd: string, resumeSessionId?: string): AgentSession {
    const raw = getSetting(`model.${id}`) || DEFAULT_MODEL
    const spec = resolveModelSpec(raw, listProviders())
    if (spec.kind === 'fallback') {
      logEvent('provider.fallback', id, { value: raw, reason: spec.reason })
    }
    const isProvider = spec.kind === 'provider'
    // modelLabel = 实际生效的引用（fallback 时是回退后的官方模型名），用于 agents 表展示与 usage 归档
    const modelLabel = isProvider ? raw : spec.model
    const session = new AgentSession(id, {
      cwd,
      systemPrompt: this.promptLoader(id),
      model: isProvider ? spec.modelId : spec.model,
      modelLabel,
      env: isProvider ? buildProviderEnv(spec.provider, process.env) : undefined,
      includeEffort: !isProvider || spec.pricing?.supports_effort === true,
      providerId: isProvider ? spec.provider.id : undefined,
      gate: this.gate,
      collabDeps: this.collabDeps,
      resumeSessionId,
    })
    this.sessions.set(id, session)
    setAgentModel(id, modelLabel)
    logEvent('agent.session_started', id, { model: modelLabel, resumed: !!resumeSessionId })
    return session
  }

  /** 为项目启动全部（或指定）agent 会话；resumeIds 提供时恢复历史上下文 */
  startAgents(cwd: string, ids: AgentId[], resumeIds?: Map<AgentId, string>): void {
    this.projectCwd = cwd
    for (const id of ids) {
      if (this.sessions.has(id)) continue
      this.createSession(id, cwd, resumeIds?.get(id))
    }
  }

  get(id: AgentId): AgentSession {
    const existing = this.sessions.get(id)
    if (existing) return existing
    // 会话被回收/未启动 → 有项目上下文时按需懒重建（不 resume，靠记忆管道补上下文）
    if (this.projectCwd) return this.createSession(id, this.projectCwd)
    throw new Error(`agent ${id} 的会话尚未启动`)
  }

  has(id: AgentId): boolean {
    return this.sessions.has(id) || this.projectCwd != null
  }

  /** 会话是否真实在线（未被回收） */
  isLive(id: AgentId): boolean {
    return this.sessions.has(id)
  }

  ask(id: AgentId, prompt: string, opts?: AskOptions): Promise<string> {
    return this.get(id).ask(prompt, opts)
  }

  /** 回收会话：关闭并清除 session_id，下次使用时全新重建（历史清零省 token） */
  async recycle(id: AgentId): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    setAgentSession(id, null)
    logEvent('agent.session_recycled', id, {})
    await s.close().catch(() => {})
  }

  /** 空闲时才回收（有进行中/排队中的工作则跳过，避免误杀） */
  recycleIfIdle(id: AgentId): void {
    const s = this.sessions.get(id)
    if (s && !s.isBusy) void this.recycle(id)
  }

  async closeAll(): Promise<void> {
    this.projectCwd = null
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()))
    this.sessions.clear()
  }
}
