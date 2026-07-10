import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, db, initDb } from '../src/db/index'
import { addUsage, usageByAgent, usageSummary } from '../src/db/dao'

// 注意：本文件必须先于任何 initDb 调用测 fail-fast，因此 initDb 放在具体用例内（vitest 单文件顺序执行）

describe('db 可注入初始化', () => {
  afterAll(() => closeDb())

  it('未 initDb 就访问 → 抛带 initDb 提示的错误（fail-fast，不静默建库）', () => {
    expect(() => db.prepare('SELECT 1')).toThrow(/initDb/)
  })

  it("initDb(':memory:') 建表齐全（schema + 迁移列）", () => {
    initDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of ['projects', 'tasks', 'usage_log', 'approvals', 'meetings', 'settings', 'mcp_servers']) {
      expect(tables).toContain(t)
    }
    // 迁移列在 :memory:（新库直接来自 schema.sql）与老库（ALTER 补齐）都必须存在
    const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((r) => (r as { name: string }).name)
    expect(taskCols).toContain('priority')
    expect(taskCols).toContain('deps')
    const projCols = db.prepare('PRAGMA table_info(projects)').all().map((r) => (r as { name: string }).name)
    expect(projCols).toContain('test_cmd')
  })

  it('initDb 幂等：二次调用返回同一实例，迁移 try/catch 吸收重复 ALTER', () => {
    const a = initDb(':memory:')
    const b = initDb(':memory:')
    expect(a).toBe(b)
  })

  it('usage 按项目归账：projectId 过滤排除 NULL 旧行，全局账含全部', () => {
    initDb(':memory:')
    const base = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }
    addUsage({ agent_id: 'backend', ...base, cost_usd: 1.0, project_id: 101 })
    addUsage({ agent_id: 'reviewer', ...base, cost_usd: 2.0, project_id: 101 })
    addUsage({ agent_id: 'backend', ...base, cost_usd: 4.0, project_id: 202 })
    addUsage({ agent_id: 'backend', ...base, cost_usd: 8.0 }) // 迁移前旧行（NULL）：只进全局账
    expect(usageSummary(undefined, 101).cost_usd).toBeCloseTo(3.0)
    expect(usageSummary(undefined, 202).cost_usd).toBeCloseTo(4.0)
    expect(usageSummary().cost_usd).toBeCloseTo(15.0)
    const byAgent101 = usageByAgent(101)
    expect(byAgent101.find((r) => r.agent_id === 'backend')!.cost_usd).toBeCloseTo(1.0)
    expect(byAgent101.find((r) => r.agent_id === 'reviewer')!.cost_usd).toBeCloseTo(2.0)
    // usage_log 有 project_id 列 + 索引
    const cols = db.prepare('PRAGMA table_info(usage_log)').all().map((r) => (r as { name: string }).name)
    expect(cols).toContain('project_id')
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_project'").get()
    expect(idx).toBeDefined()
  })

  it('Proxy 过桥：prepare/exec/pragma/transaction 都工作（原生方法 this 绑定正确）', () => {
    db.exec("CREATE TABLE IF NOT EXISTS _probe (v TEXT)")
    db.prepare('INSERT INTO _probe (v) VALUES (?)').run('x')
    expect((db.prepare('SELECT COUNT(*) n FROM _probe').get() as { n: number }).n).toBe(1)
    expect(db.pragma('user_version')).toBeDefined()
    const insertTwo = db.transaction((vals: string[]) => {
      for (const v of vals) db.prepare('INSERT INTO _probe (v) VALUES (?)').run(v)
    })
    insertTwo(['a', 'b'])
    expect((db.prepare('SELECT COUNT(*) n FROM _probe').get() as { n: number }).n).toBe(3)
  })
})
