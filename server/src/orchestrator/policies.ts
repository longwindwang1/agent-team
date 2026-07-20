/** 危险 Bash 命令模式 → 必须走用户审批 */
export const DANGEROUS_BASH: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-\w*[rf]\w*\s+)+/i, label: '递归/强制删除文件' },
  { re: /\b(rmdir|rd)\b.*\/s/i, label: '递归删除目录' },
  { re: /\bdel\b.*\/[fsq]/i, label: '强制删除文件' },
  { re: /\bgit\s+push\b/i, label: 'git push（推送到远程）' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard（丢弃改动）' },
  { re: /\bgit\s+clean\b/i, label: 'git clean（删除未跟踪文件）' },
  { re: /(?:^|&&|;|\|)\s*(curl|wget|Invoke-WebRequest|iwr)\b/i, label: '访问外部网络' },
  { re: /\bnpm\s+(publish|adduser)\b/i, label: 'npm 发布' },
  { re: /\b(shutdown|format|mkfs|reg\s+add|schtasks)\b/i, label: '系统级危险操作' },
]

/** 需要审批的软性操作：安装新依赖（只匹配命令位置，避免 grep "npm install" 这类引号内容误报） */
export const INSTALL_BASH = /(?:^|&&|;|\|)\s*((npm|pnpm|yarn)\s+(install|i|add)\s+\S|pip\s+install\b)/i

export function classifyBash(cmd: string): { label: string } | null {
  const danger = DANGEROUS_BASH.find((d) => d.re.test(cmd))
  if (danger) return { label: danger.label }
  if (INSTALL_BASH.test(cmd)) return { label: '安装新依赖' }
  return null
}

// ---------- 用户 MCP 写工具的工作区边界 ----------

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 工具名（去前缀后）疑似写操作：写/删/移/建等。读类 MCP 工具不设边界（浏览、查询不受限） */
const MCP_WRITE_RE = /write|edit|create|delete|remove|move|copy|mkdir|rename|save|append|upload|put|trash/i

/** 收集 input 里深度 ≤3 的全部字符串值 */
function collectStrings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || v == null) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, depth + 1, out)
  else if (typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, depth + 1, out)
  return out
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * 用户 MCP 写类工具的路径边界：入参里出现指向工作区之外的绝对路径 / file:// URL → 返回违规路径（deny 用）。
 * 与内置 Write/Edit 的工作区约束同一哲学：无条件硬规则，不走审批。
 * 内置 collab 工具与读类工具不检查；相对路径不检查（MCP server 自有 cwd，无法可靠判定基准）。
 */
export function mcpBoundaryViolation(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__collab__')) return null
  const bare = toolName.split('__').pop() ?? ''
  if (!MCP_WRITE_RE.test(bare)) return null
  const root = norm(path.resolve(cwd))
  for (const s of collectStrings(input)) {
    let candidate: string | null = null
    if (/^file:\/\//i.test(s)) {
      try {
        candidate = fileURLToPath(s)
      } catch {
        continue
      }
    } else if (path.isAbsolute(s)) {
      candidate = s
    }
    if (!candidate) continue
    const rel = path.relative(root, norm(path.resolve(candidate)))
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return s
  }
  return null
}
