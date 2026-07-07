import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
// lib/workspace.ts 不 import db，可直接引入
import { isTraversal, listTree, mimeFor, readWorkspaceFile, resolveSafe } from '../src/lib/workspace'

const REPO = 'D:\\ws\\project-1\\repo'

describe('isTraversal 路径穿越判定', () => {
  const cases: Array<[string, boolean]> = [
    ['README.md', false],
    ['src/timer.js', false],
    ['a/b/../c.txt', false], // 归一后仍在 repo 内
    ['', false], // repo 根
    ['..', true],
    ['../x', true],
    ['a/../../x', true],
    ['a\\..\\..\\x', true], // Windows 反斜杠变体
    ['C:\\Windows\\system32', true],
    ['/etc/passwd', true],
    ['..\\..\\secret', true],
  ]
  for (const [rel, expected] of cases) {
    it(`${JSON.stringify(rel)} -> ${expected ? '拦截' : '放行'}`, () => {
      expect(isTraversal(REPO, rel)).toBe(expected)
    })
  }
})

describe('resolveSafe + listTree + readWorkspaceFile（真实临时目录）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ws-test-'))
  mkdirSync(path.join(tmp, 'src'))
  mkdirSync(path.join(tmp, '.git'))
  mkdirSync(path.join(tmp, 'node_modules'))
  writeFileSync(path.join(tmp, 'a.txt'), 'hello')
  writeFileSync(path.join(tmp, 'src', 'b.js'), 'console.log(1)')
  writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref')
  writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([1, 2, 0, 4]))

  it('resolveSafe 放行 repo 内、拦截越界', () => {
    expect(resolveSafe(tmp, 'a.txt')).toBeTruthy()
    expect(resolveSafe(tmp, '../outside')).toBeNull()
  })

  it('listTree 排除 .git/node_modules、报告大小', () => {
    const { entries, truncated } = listTree(tmp)
    const paths = entries.map((e) => e.path)
    expect(paths).toContain('a.txt')
    expect(paths).toContain('src')
    expect(paths).toContain('src/b.js')
    expect(paths.some((p) => p.startsWith('.git'))).toBe(false)
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(entries.find((e) => e.path === 'a.txt')?.size).toBe(5)
    expect(truncated).toBe(false)
  })

  it('readWorkspaceFile 文本与二进制', () => {
    const text = readWorkspaceFile(path.join(tmp, 'a.txt'))
    expect(text.kind).toBe('text')
    if (text.kind === 'text') expect(text.content).toBe('hello')
    expect(readWorkspaceFile(path.join(tmp, 'bin.dat')).kind).toBe('binary')
  })
})

describe('mimeFor', () => {
  it('常见类型与兜底', () => {
    expect(mimeFor('index.html')).toContain('text/html')
    expect(mimeFor('app.JS')).toContain('javascript')
    expect(mimeFor('x.woff2')).toBe('font/woff2')
    expect(mimeFor('unknown.xyz')).toBe('application/octet-stream')
  })
})
