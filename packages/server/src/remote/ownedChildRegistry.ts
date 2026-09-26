import type { ChildProcess } from "node:child_process";

interface OwnedChildState {
  closed: Promise<void>;
  resolveClosed: () => void;
}

/**
 * 后端自己 spawn 的子进程注册表：一次性命令正常结束（exit/close/error）后立即出队，
 * 避免集合无界增长；dispose 时统一 end stdin → 短宽限 → kill 兜底，
 * 覆盖 Docker/WSL exec 的常驻远端 server 子进程。
 * 语义与 WSL 后端既有 ownedChildren/disposeAndWait 实现一致，收口为唯一实现供两个后端复用。
 */
export class OwnedChildRegistry {
  private readonly children = new Map<ChildProcess, OwnedChildState>();

  get size(): number {
    return this.children.size;
  }

  track(child: ChildProcess): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      const state = this.children.get(child);
      if (!state) {
        return;
      }
      this.children.delete(child);
      state.resolveClosed();
    };
    this.children.set(child, { closed, resolveClosed });
    child.once("error", finish);
    child.once("exit", finish);
    child.once("close", finish);
  }

  async disposeAndWait(options?: {
    graceTimeoutMs?: number;
    killWaitTimeoutMs?: number;
  }): Promise<void> {
    const graceTimeoutMs = Math.max(options?.graceTimeoutMs ?? 300, 0);
    const killWaitTimeoutMs = Math.max(options?.killWaitTimeoutMs ?? 250, 0);
    const entries = Array.from(this.children.entries());
    // 先同步关闭所有归属子进程的 stdin，让远端 stdio server 立即收到 EOF；
    // 宽限期后也只 kill 这些已证明归属的 child，不扩大到共享运行时（如 distro/容器本身）。
    for (const [child] of entries) {
      this.endOwnedChildInput(child);
    }
    await Promise.all(
      entries.map(async ([child, state]) => {
        if (await this.waitForOwnedChildClose(state.closed, graceTimeoutMs)) {
          return;
        }
        if (this.children.has(child)) {
          child.kill();
        }
        await this.waitForOwnedChildClose(state.closed, killWaitTimeoutMs);
      }),
    );
  }

  private endOwnedChildInput(child: ChildProcess): void {
    if (!child.stdin || child.stdin.writableEnded) {
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // stdin 已异常关闭时继续进入本 child 的 kill fallback。
    }
  }

  private async waitForOwnedChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return result;
  }
}
