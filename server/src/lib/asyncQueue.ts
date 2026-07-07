/** 简单的异步队列：query() 的流式输入源，push 后由消费方逐条取走 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private wakers: Array<() => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.wakers.splice(0).forEach((w) => w())
  }

  close(): void {
    this.closed = true
    this.wakers.splice(0).forEach((w) => w())
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.closed || this.items.length > 0) {
      if (this.items.length > 0) {
        yield this.items.shift()!
        continue
      }
      await new Promise<void>((res) => this.wakers.push(res))
    }
  }
}
