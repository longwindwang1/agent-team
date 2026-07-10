/** 从回复中提取 ```json ... ``` 代码块并解析（纯函数，从 meetingRunner 迁出——
 *  让 taskFlow 等模块不必为了它拉起 meetingRunner→engine→SDK 的整条运行时链） */
export function parseJsonBlock<T>(text: string): T | null {
  const match = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/)
  const raw = match ? match[1] : text
  try {
    return JSON.parse(raw.trim()) as T
  } catch {
    // 尝试截取第一个 { 到最后一个 }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}
