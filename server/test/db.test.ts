import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, db, initDb } from '../src/db/index'

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
