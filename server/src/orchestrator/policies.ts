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
