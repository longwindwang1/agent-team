import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} 失败: ${stderr || err.message}`))
      else resolve(stdout)
    })
  })
}

/** 初始化项目主仓库 workspaces/project-<id>/repo */
export async function initProjectRepo(projectDir: string, projectName: string, requirement: string): Promise<string> {
  const repoDir = path.join(projectDir, 'repo')
  if (existsSync(path.join(repoDir, '.git'))) return repoDir
  mkdirSync(repoDir, { recursive: true })
  await git(['init', '-b', 'main'], repoDir)
  await git(['config', 'user.name', 'Agent Team'], repoDir)
  await git(['config', 'user.email', 'agents@agent-team.local'], repoDir)
  writeFileSync(path.join(repoDir, 'README.md'), `# ${projectName}\n\n## 需求\n\n${requirement}\n`, 'utf-8')
  await git(['add', '-A'], repoDir)
  await git(['commit', '-m', 'chore: 初始化项目仓库'], repoDir)
  return repoDir
}

/** 为任务创建独立 worktree（分支 task-<id>） */
export async function createTaskWorktree(projectDir: string, taskId: number): Promise<{ worktree: string; branch: string }> {
  const repoDir = path.join(projectDir, 'repo')
  const branch = `task-${taskId}`
  const worktree = path.join(projectDir, `wt-task-${taskId}`)
  if (!existsSync(worktree)) {
    await git(['worktree', 'add', '-b', branch, worktree, 'main'], repoDir)
  }
  return { worktree, branch }
}

/** 任务分支相对 main 的 diff（排除 lockfile/产物，截断避免撑爆上下文；stat 保留全量） */
export async function taskDiff(projectDir: string, branch: string, maxChars = 40000): Promise<string> {
  const repoDir = path.join(projectDir, 'repo')
  const excludes = [
    ':(exclude)package-lock.json',
    ':(exclude)pnpm-lock.yaml',
    ':(exclude)yarn.lock',
    ':(exclude)*.min.js',
    ':(exclude)*.map',
    ':(exclude)dist/**',
  ]
  const stat = await git(['diff', '--stat', `main...${branch}`], repoDir)
  const diff = await git(['diff', `main...${branch}`, '--', '.', ...excludes], repoDir)
  const body = diff.length > maxChars ? diff.slice(0, maxChars) + `\n... [diff truncated, total ${diff.length} chars]` : diff
  return `${stat}\n${body}`
}

/** 合并任务分支回 main 并清理 worktree；冲突时恢复仓库状态再抛错 */
export async function mergeTaskBranch(projectDir: string, taskId: number): Promise<void> {
  const repoDir = path.join(projectDir, 'repo')
  const branch = `task-${taskId}`
  const worktree = path.join(projectDir, `wt-task-${taskId}`)
  try {
    await git(['merge', '--no-ff', branch, '-m', `merge: task #${taskId} (${branch})`], repoDir)
  } catch (err) {
    // 必须把仓库从冲突状态恢复干净，否则后续所有任务的合并都会失败
    await git(['merge', '--abort'], repoDir).catch(() => {})
    throw err
  }
  await git(['worktree', 'remove', worktree, '--force'], repoDir).catch(() => {})
  await git(['branch', '-D', branch], repoDir).catch(() => {})
}

/** worktree 中是否有未提交改动之外的、相对 main 的提交 */
export async function branchHasCommits(projectDir: string, branch: string): Promise<boolean> {
  const repoDir = path.join(projectDir, 'repo')
  const out = await git(['rev-list', '--count', `main..${branch}`], repoDir)
  return Number(out.trim()) > 0
}
