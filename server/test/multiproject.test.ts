import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 防真弹 Windows 桌面通知（ApprovalGate.notifyDesktop）
vi.mock('node-notifier', () => ({ default: { notify: vi.fn() } }))

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, initDb } from '../src/db/index'
import {
  createProject,
  createTask,
  decideApproval,
  getTask,
  pendingApprovals,
  resumeIdsFor,
  setAgentSessionId,
  setProjectStatus,
  setSetting,
} from '../src/db/dao'
import { git, initProjectRepo } from '../src/lib/git'
import { TaskFlow } from '../src/orchestrator/taskFlow'
import { ApprovalGate } from '../src/orchestrator/approvalGate'
import { maxConcurrentProjects } from '../src/settings'
import type { AgentPool } from '../src/orchestrator/agentPool'
import type { AgentId, ProjectRow } from '../src/types'

/*
 * 多项目并发的地基测试：
 * - agent_sessions 表按 (project, agent) 隔离恢复 id
 * - 审批门 pending 计数按项目作用域（A 项目的待批不抑制 B 项目同角色）
 * - 双项目 TaskFlow 真并行（独立池 + 独立 git 仓库，Promise.all 同时跑完、互不串仓）
 */

type AskFn = (prompt: string, opts?: unknown) => Promise<string>

class StubSession {
  constructor(
    private handlers: AskFn[],
    readonly label: string,
  ) {}
  ask: AskFn = (prompt) => {
    const h = this.handlers.shift()
    if (!h) return Promise.reject(new Error(`stub ${this.label}: 未编排的 ask：${String(prompt).slice(0, 80)}`))
    return h(String(prompt))
  }
}

function makeStubPool(scripts: Partial<Record<AgentId, AskFn[]>>) {
  const sessions = new Map<string, StubSession>()
  const sessionFor = (id: string) => {
    let s = sessions.get(id)
    if (!s) {
      s = new StubSession(scripts[id as AgentId] ?? [], id)
      sessions.set(id, s)
    }
    return s
  }
  return {
    acquireTaskSession: (id: string) => sessionFor(id),
    ask: (id: string, prompt: string, opts?: unknown) => sessionFor(id).ask(prompt, opts),
    isLive: () => true,
    recycleIfIdle: () => {},
    recycleOversized: () => {},
  } as unknown as AgentPool
}

const json = (obj: unknown): AskFn => async () => '```json\n' + JSON.stringify(obj) + '\n```'

const commitDev = (projectDir: string, taskId: number, content: string): AskFn => async () => {
  const wt = path.join(projectDir, `wt-task-${taskId}`)
  writeFileSync(path.join(wt, 'out.txt'), content, 'utf-8')
  await git(['add', '-A'], wt)
  await git(['commit', '-m', `feat: task ${taskId}`], wt)
  return `任务 ${taskId} 完成`
}

let tmpRoot: string
let seq = 0

async function fixture(): Promise<{ project: ProjectRow; dir: string }> {
  const dir = path.join(tmpRoot, `p${++seq}`)
  await initProjectRepo(dir, `并发项目 ${seq}`, '测试需求')
  const project = createProject(`并发项目 ${seq}`, '测试需求', 10)
  setProjectStatus(project.id, 'running')
  return { project, dir }
}

beforeAll(() => {
  initDb(':memory:')
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentteam-mp-'))
  setSetting('role_enabled.scribe', 'off')
  setSetting('role_enabled.challenger', 'off')
  setSetting('challenge_tasks', 'off')
  setSetting('final_review', 'on')
  setSetting('selftest_gate', 'on')
  setSetting('approval_policy', 'budget_only')
  setSetting('max_review_cycles', '3')
})

afterAll(() => {
  closeDb()
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Windows 文件锁：临时目录残留可接受
  }
})

describe('agent_sessions（按项目隔离的会话恢复 id）', () => {
  it('同角色不同项目互不覆盖；null 清除；projectId 空则忽略', () => {
    setAgentSessionId(101, 'backend', 'sess-A')
    setAgentSessionId(102, 'backend', 'sess-B')
    setAgentSessionId(101, 'reviewer', 'sess-A-r')
    expect(resumeIdsFor(101)).toEqual(new Map([['backend', 'sess-A'], ['reviewer', 'sess-A-r']]))
    expect(resumeIdsFor(102)).toEqual(new Map([['backend', 'sess-B']]))
    // 覆盖更新
    setAgentSessionId(101, 'backend', 'sess-A2')
    expect(resumeIdsFor(101).get('backend')).toBe('sess-A2')
    // 清除只影响本项目
    setAgentSessionId(101, 'backend', null)
    expect(resumeIdsFor(101).has('backend')).toBe(false)
    expect(resumeIdsFor(102).get('backend')).toBe('sess-B')
    // 无项目上下文：no-op 不炸
    setAgentSessionId(null, 'backend', 'ghost')
    expect(resumeIdsFor(102).get('backend')).toBe('sess-B')
  })
})

describe('ApprovalGate（pending 按项目作用域）', () => {
  it('A 项目的待批不抑制 B 项目同角色；无 project_id 的请求抑制所有项目', async () => {
    const gate = new ApprovalGate()
    // budget 类永远走人批 → 真实 pending
    const p1 = gate.request({ project_id: 201, requested_by: 'backend', title: '预算A', kind: 'budget' })
    expect(gate.hasPendingFor('backend', 201)).toBe(true)
    expect(gate.hasPendingFor('backend', 202)).toBe(false) // 不串项目
    expect(gate.hasPendingFor('reviewer', 201)).toBe(false) // 不串角色

    // 无 project_id 的历史式请求 → 全局键，两个项目都抑制（只紧不松）
    const p2 = gate.request({ requested_by: 'qa', title: '全局待批', kind: 'budget' })
    expect(gate.hasPendingFor('qa', 201)).toBe(true)
    expect(gate.hasPendingFor('qa', 202)).toBe(true)

    // resolve 后计数归零
    for (const pending of pendingApprovals()) {
      gate.resolve(decideApproval(pending.id, 'approved', undefined, 'ok')!)
    }
    await Promise.all([p1, p2])
    expect(gate.hasPendingFor('backend', 201)).toBe(false)
    expect(gate.hasPendingFor('qa', 202)).toBe(false)
  })
})

describe('双项目并行 TaskFlow（独立池 + 独立仓库）', () => {
  it('两个项目同时跑完，任务各归各仓、互不串写', { timeout: 40_000 }, async () => {
    const a = await fixture()
    const b = await fixture()
    const taskA = createTask({ project_id: a.project.id, title: 'A 的功能', assignee: 'backend', created_by: 'coordinator' })
    const taskB = createTask({ project_id: b.project.id, title: 'B 的功能', assignee: 'backend', created_by: 'coordinator' })

    const poolA = makeStubPool({
      backend: [commitDev(a.dir, taskA.id, 'from-project-A')],
      reviewer: [json({ approve: true })],
      qa: [json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const poolB = makeStubPool({
      backend: [commitDev(b.dir, taskB.id, 'from-project-B')],
      reviewer: [json({ approve: true })],
      qa: [json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const flowA = new TaskFlow(poolA, new ApprovalGate(), a.project.id, a.dir)
    const flowB = new TaskFlow(poolB, new ApprovalGate(), b.project.id, b.dir)

    // 真并行：两条流同时推进（各自事件驱动调度互不知晓对方）
    const [ra, rb] = await Promise.all([flowA.runAll(), flowB.runAll()])
    expect(ra.done).toBe(true)
    expect(rb.done).toBe(true)
    expect(getTask(taskA.id)!.status).toBe('done')
    expect(getTask(taskB.id)!.status).toBe('done')

    // 各归各仓：A 仓 main 只有 A 的任务合并，B 同理
    const logA = await git(['log', '--oneline', 'main'], path.join(a.dir, 'repo'))
    const logB = await git(['log', '--oneline', 'main'], path.join(b.dir, 'repo'))
    expect(logA).toContain(`merge: task #${taskA.id}`)
    expect(logA).not.toContain(`merge: task #${taskB.id}`)
    expect(logB).toContain(`merge: task #${taskB.id}`)
    expect(logB).not.toContain(`merge: task #${taskA.id}`)
  })
})

describe('max_concurrent_projects', () => {
  it('钳制在 1-4，非法值回默认 2', () => {
    setSetting('max_concurrent_projects', '3')
    expect(maxConcurrentProjects()).toBe(3)
    setSetting('max_concurrent_projects', '99')
    expect(maxConcurrentProjects()).toBe(4)
    setSetting('max_concurrent_projects', '0')
    expect(maxConcurrentProjects()).toBe(2)
    setSetting('max_concurrent_projects', 'abc')
    expect(maxConcurrentProjects()).toBe(2)
    setSetting('max_concurrent_projects', '2')
  })
})
