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
  listEvents,
  pendingApprovals,
  setProjectStatus,
  setProjectTestCmd,
  setSetting,
  setTaskStatus,
  updateTask,
} from '../src/db/dao'
import { git, initProjectRepo, createTaskWorktree } from '../src/lib/git'
import { TaskFlow } from '../src/orchestrator/taskFlow'
import { ApprovalGate } from '../src/orchestrator/approvalGate'
import type { AgentPool } from '../src/orchestrator/agentPool'
import type { AgentId, ProjectRow, TaskRow } from '../src/types'
import { tx } from '../src/orchestrator/texts'

/*
 * 测试环境要点：
 * - initDb(':memory:')；每用例独立 project 行隔离
 * - git 用真实临时仓库（initProjectRepo 现成 fixture，worktree 继承 repo-local user 配置）
 * - pool 桩是 plain object：只实现 taskFlow 真用到的面；未编排的 ask 直接 reject
 *   → 经 launch() 的 catch → blockTask 响亮失败，绝不静默挂死
 * - 陷阱：approval_policy 默认 budget_only 会自动批 decision 类——pending 流用 budget/rework 类
 * - role_enabled.scribe=off 静音 distillTask 的火后不理 ask
 */

type AskFn = (prompt: string, opts?: unknown) => Promise<string>

class StubSession {
  calls: string[] = []
  constructor(
    private handlers: AskFn[],
    readonly label: string,
    private readonly onAsk?: (agent: string, prompt: string) => void,
  ) {}
  ask: AskFn = (prompt) => {
    this.calls.push(String(prompt).slice(0, 60))
    this.onAsk?.(this.label, String(prompt))
    const h = this.handlers.shift()
    if (!h) return Promise.reject(new Error(`stub ${this.label}: 未编排的 ask：${String(prompt).slice(0, 80)}`))
    return h(String(prompt))
  }
}

function makeStubPool(scripts: Partial<Record<AgentId, AskFn[]>>, onAsk?: (agent: string, prompt: string) => void) {
  const sessions = new Map<string, StubSession>()
  const sessionFor = (id: string) => {
    let s = sessions.get(id)
    if (!s) {
      s = new StubSession(scripts[id as AgentId] ?? [], id, onAsk)
      sessions.set(id, s)
    }
    return s
  }
  const pool = {
    acquireTaskSession: (id: string) => sessionFor(id),
    ask: (id: string, prompt: string, opts?: unknown) => sessionFor(id).ask(prompt, opts),
    isLive: () => true,
    recycleIfIdle: () => {},
    recycleOversized: () => {},
  } as unknown as AgentPool
  return { pool, sessions }
}

const json = (obj: unknown): AskFn => async () => '```json\n' + JSON.stringify(obj) + '\n```'

/** dev 桩：在任务 worktree 里写文件并提交（branchHasCommits 才能过） */
const commitDev = (projectDir: string, taskId: number, file = 'out.txt', content = 'done'): AskFn => async () => {
  const wt = path.join(projectDir, `wt-task-${taskId}`)
  writeFileSync(path.join(wt, file), content, 'utf-8')
  await git(['add', '-A'], wt)
  await git(['commit', '-m', `feat: task ${taskId}`], wt)
  return `任务 ${taskId} 完成`
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

let tmpRoot: string
let seq = 0

/** 每用例独立 project + 真实 git 仓库 */
async function fixture(): Promise<{ project: ProjectRow; dir: string }> {
  const dir = path.join(tmpRoot, `p${++seq}`)
  await initProjectRepo(dir, `测试项目 ${seq}`, '测试需求')
  const project = createProject(`测试项目 ${seq}`, '测试需求', 10)
  setProjectStatus(project.id, 'running')
  return { project, dir }
}

function mkTask(projectId: number, over: Partial<{ title: string; assignee: string; deps: number[] }> = {}): TaskRow {
  const row = createTask({
    project_id: projectId,
    title: over.title ?? '实现功能',
    description: '写完提交',
    assignee: (over.assignee ?? 'backend') as AgentId,
    created_by: 'coordinator',
    owns_files: [],
  })
  if (over.deps?.length) updateTask(row.id, { deps: JSON.stringify(over.deps) })
  return getTask(row.id)!
}

beforeAll(() => {
  initDb(':memory:')
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agentteam-tf-'))
  // 基线设置：链路只留 review/qa/final（挑战者与书记官静音），防止未编排 ask
  setSetting('role_enabled.scribe', 'off')
  setSetting('role_enabled.challenger', 'off')
  setSetting('challenge_tasks', 'off')
  setSetting('final_review', 'on')
  setSetting('selftest_gate', 'on') // 无 test_cmd 的项目自动跳过
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

describe('TaskFlow 状态机（真实 git + in-memory db + pool 桩）', () => {
  it('全链路 assigned→…→final→done：合并落 main、事件齐全', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    const { pool } = makeStubPool({
      backend: [commitDev(dir, task.id, 'a.txt', 'hello')],
      reviewer: [json({ approve: true, summary: '干净' })],
      qa: [json({ pass: true, summary: '实测通过' })],
      coordinator: [json({ complete: true })],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    const result = await flow.runAll()
    expect(result.done).toBe(true)
    expect(getTask(task.id)!.status).toBe('done')
    // 合并进 main（merge message 是 diff 追溯契约）
    const log = await git(['log', '--oneline', 'main'], path.join(dir, 'repo'))
    expect(log).toContain(`merge: task #${task.id}`)
    const types = listEvents(200).map((e) => e.type)
    for (const t of ['task.dev_started', 'task.reviewed', 'task.qa', 'task.final', 'task.done']) {
      expect(types).toContain(t)
    }
  })

  it('审查打回：assignee 保留、cycles+1、notes 带前缀，返工后走完', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    let snapshotAtRework: TaskRow | null = null
    const { pool } = makeStubPool({
      backend: [
        commitDev(dir, task.id),
        async () => {
          snapshotAtRework = getTask(task.id)! // 第二次被派活时，打回状态已落库
          return commitDev(dir, task.id, 'fix.txt', 'fixed')('')
        },
      ],
      reviewer: [json({ approve: false, summary: '缺边界处理', findings: [{ severity: 'high', issue: '未校验入参' }] }), json({ approve: true })],
      qa: [json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    const result = await flow.runAll()
    expect(result.done).toBe(true)
    expect(snapshotAtRework).not.toBeNull()
    expect(snapshotAtRework!.assignee).toBe('backend') // 打回给原开发者
    expect(snapshotAtRework!.review_cycles).toBe(1)
    expect(snapshotAtRework!.review_notes).toContain('缺边界处理')
  })

  it('QA 打回带 qa 前缀意见', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    let reworkNote = ''
    const { pool } = makeStubPool({
      backend: [
        commitDev(dir, task.id),
        async () => {
          reworkNote = getTask(task.id)!.review_notes ?? ''
          return commitDev(dir, task.id, 'fix.txt', 'fixed')('')
        },
      ],
      reviewer: [json({ approve: true }), json({ approve: true })],
      qa: [json({ pass: false, summary: '用例挂了', issues: [{ severity: 'high', case: 'add(1,2)', expected: '3', actual: '4' }] }), json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    expect((await flow.runAll()).done).toBe(true)
    expect(reworkNote).toContain('用例挂了')
    expect(reworkNote).toContain('add(1,2)')
  })

  it('JSON 格式重试落在同一会话（jsonRetry 指涉上一条回复）', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    const { pool, sessions } = makeStubPool({
      backend: [commitDev(dir, task.id)],
      reviewer: [async () => '我觉得挺好的，就是没给 JSON', json({ approve: true })],
      qa: [json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    expect((await flow.runAll()).done).toBe(true)
    // 两次 ask 都进了同一个 reviewer 桩会话（handlers 顺序消费即证明）
    expect(sessions.get('reviewer')!.calls.length).toBe(2)
    expect(listEvents(200).some((e) => e.type === 'json.retry')).toBe(true)
  })

  it('依赖门控：B deps=[A] 时 B 的 dev 绝不先于 A 完成开工', { timeout: 30_000 }, async () => {
    const { project, dir } = await fixture()
    const order: string[] = []
    const a = mkTask(project.id, { title: 'A 实现' })
    const b = mkTask(project.id, { title: 'B 依赖 A', deps: [a.id] })
    const { pool } = makeStubPool(
      {
        backend: [
          async () => {
            order.push('dev-A')
            return commitDev(dir, a.id, 'a.txt', 'A')('')
          },
          async () => {
            order.push('dev-B')
            expect(getTask(a.id)!.status).toBe('done') // B 开工时 A 必须已 done
            return commitDev(dir, b.id, 'b.txt', 'B')('')
          },
        ],
        reviewer: [json({ approve: true }), json({ approve: true })],
        qa: [json({ pass: true }), json({ pass: true })],
        coordinator: [json({ complete: true }), json({ complete: true })],
      },
    )
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    expect((await flow.runAll()).done).toBe(true)
    expect(order).toEqual(['dev-A', 'dev-B'])
  })

  it('开发零提交 → 任务阻塞 + 依赖下游级联阻塞', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const a = mkTask(project.id, { title: '不交活的 A' })
    const b = mkTask(project.id, { title: '下游 B', deps: [a.id] })
    const { pool } = makeStubPool({
      backend: [async () => '我说完成了但其实什么都没提交'],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    const result = await flow.runAll()
    expect(result.done).toBe(false)
    expect(result.blocked.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    expect(getTask(a.id)!.status).toBe('blocked')
    const bRow = getTask(b.id)!
    expect(bRow.status).toBe('blocked')
    expect(bRow.review_notes).toContain(`#${a.id}`) // 依赖阻塞前缀指向根因
  })

  it('stale-toggle：停在 review 的任务在角色全关后零 ask 直达合并', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    // 手工把任务推进到 review 态：真实建 worktree + 提交（merge 需要真分支）
    const { worktree, branch } = await createTaskWorktree(dir, task.id)
    updateTask(task.id, { worktree, branch })
    writeFileSync(path.join(worktree, 'x.txt'), 'x', 'utf-8')
    await git(['add', '-A'], worktree)
    await git(['commit', '-m', 'feat: x'], worktree)
    setTaskStatus(task.id, 'review')
    // 关掉全部质检角色与终审
    setSetting('role_enabled.reviewer', 'off')
    setSetting('role_enabled.qa', 'off')
    setSetting('final_review', 'off')
    try {
      const { pool, sessions } = makeStubPool({})
      const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
      expect((await flow.runAll()).done).toBe(true)
      expect(getTask(task.id)!.status).toBe('done')
      expect([...sessions.values()].flatMap((s) => s.calls)).toEqual([]) // 零 ask
    } finally {
      setSetting('role_enabled.reviewer', 'on')
      setSetting('role_enabled.qa', 'on')
      setSetting('final_review', 'on')
    }
  })

  it('final_review=off：过 QA 后直接合并，协调者零参与', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    setSetting('final_review', 'off')
    try {
      const { pool, sessions } = makeStubPool({
        backend: [commitDev(dir, task.id)],
        reviewer: [json({ approve: true })],
        qa: [json({ pass: true })],
      })
      const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
      expect((await flow.runAll()).done).toBe(true)
      expect(sessions.has('coordinator')).toBe(false)
    } finally {
      setSetting('final_review', 'on')
    }
  })

  it('自测门：test_cmd 失败直接打回（审查零参与），修复后通过', { timeout: 30_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    setProjectTestCmd(project.id, 'node selftest.js')
    let noteAtRework = ''
    const { pool, sessions } = makeStubPool({
      backend: [
        // 第一轮：提交一个会失败的自测脚本
        async () => {
          const wt = path.join(dir, `wt-task-${task.id}`)
          writeFileSync(path.join(wt, 'selftest.js'), 'console.error("BOOM");process.exit(1)', 'utf-8')
          await git(['add', '-A'], wt)
          await git(['commit', '-m', 'feat: broken'], wt)
          return '完成（自以为）'
        },
        // 第二轮：修好
        async () => {
          noteAtRework = getTask(task.id)!.review_notes ?? ''
          const wt = path.join(dir, `wt-task-${task.id}`)
          writeFileSync(path.join(wt, 'selftest.js'), 'console.log("ok")', 'utf-8')
          await git(['add', '-A'], wt)
          await git(['commit', '-m', 'fix: pass'], wt)
          return '真完成了'
        },
      ],
      reviewer: [json({ approve: true })],
      qa: [json({ pass: true })],
      coordinator: [json({ complete: true })],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    expect((await flow.runAll()).done).toBe(true)
    expect(noteAtRework).toContain('自测门失败')
    expect(noteAtRework).toContain('BOOM')
    expect(sessions.get('reviewer')!.calls.length).toBe(1) // 失败那轮没进审查
    const types = listEvents(300).map((e) => e.type)
    expect(types).toContain('task.selftest_fail')
    expect(types).toContain('task.selftest_pass')
  })

  it('返工超限升级用户：驳回 → 放弃并阻塞', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    setSetting('max_review_cycles', '1')
    try {
      const gate = new ApprovalGate()
      const { pool } = makeStubPool({
        backend: [commitDev(dir, task.id)],
        reviewer: [json({ approve: false, summary: '不行' })],
      })
      const flow = new TaskFlow(pool, gate, project.id, dir)
      const run = flow.runAll()
      await until(() => pendingApprovals().length > 0)
      const pending = pendingApprovals()[0]
      expect(pending.title).toContain(`#${task.id}`)
      gate.resolve(decideApproval(pending.id, 'rejected', undefined, '放弃吧')!)
      const result = await run
      expect(result.done).toBe(false)
      expect(getTask(task.id)!.status).toBe('blocked')
    } finally {
      setSetting('max_review_cycles', '3')
    }
  })

  it('返工超限升级用户：强制通过 → 合并为 done', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    setSetting('max_review_cycles', '1')
    try {
      const gate = new ApprovalGate()
      const { pool } = makeStubPool({
        backend: [commitDev(dir, task.id)],
        reviewer: [json({ approve: false, summary: '还是不行' })],
      })
      const flow = new TaskFlow(pool, gate, project.id, dir)
      const run = flow.runAll()
      await until(() => pendingApprovals().length > 0)
      const pending = pendingApprovals()[0]
      gate.resolve(decideApproval(pending.id, 'approved', tx().reworkOptForceMerge)!)
      const result = await run
      expect(result.done).toBe(true)
      const row = getTask(task.id)!
      expect(row.status).toBe('done')
      expect(row.review_notes).toBe(tx().forcedPassNote)
    } finally {
      setSetting('max_review_cycles', '3')
    }
  })

  it('配额类错误：任务回位 assigned + 项目整体暂停（不误标 blocked）', { timeout: 20_000 }, async () => {
    const { project, dir } = await fixture()
    const task = mkTask(project.id)
    const { pool } = makeStubPool({
      backend: [async () => Promise.reject(new Error('API error: insufficient balance, please top up'))],
    })
    const flow = new TaskFlow(pool, new ApprovalGate(), project.id, dir)
    const run = flow.runAll()
    await until(() => {
      const p = getTask(task.id)
      return p?.status === 'assigned' && listEvents(100).some((e) => e.type === 'quota.exhausted')
    })
    flow.stop() // 暂停态的 runAll 会一直等 resume，测试手动止损
    await run
    expect(getTask(task.id)!.status).toBe('assigned')
    expect(getTask(task.id)!.status).not.toBe('blocked')
  })
})
