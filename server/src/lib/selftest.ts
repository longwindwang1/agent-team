import { exec } from 'node:child_process'

export interface SelfTestResult {
  ok: boolean
  /** 合并 stdout+stderr 的尾部（打回说明用；见 clampOutput） */
  output: string
  /** 超时被杀 */
  timedOut: boolean
}

/** 打回说明里只带输出尾部：错误信息几乎总在末尾，头部是无用的启动噪音 */
export function clampOutput(stdout: string, stderr: string, max = 2000): string {
  const merged = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (merged.length <= max) return merged
  return `…（前 ${merged.length - max} 字符省略）\n${merged.slice(-max)}`
}

/**
 * 自测门：在任务 worktree 里跑项目声明的测试命令（如 node --test / npm test）。
 * shell 执行以兼容 npm/复合命令；超时视为失败（防挂死的测试卡住整条流水线）。
 */
export function runSelfTest(cwd: string, cmd: string, timeoutMs = 5 * 60_000): Promise<SelfTestResult> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as { killed?: boolean }).killed === true
      resolve({
        ok: !err,
        output: clampOutput(stdout ?? '', stderr ?? ''),
        timedOut,
      })
    })
  })
}
