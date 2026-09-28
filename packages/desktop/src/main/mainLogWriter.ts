import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** 文件队列仅属于 Main；串行批量写盘，不能把每条日志变成主线程同步磁盘 IO。 */
export function createMainLogWriter(
  options: {
    append?: (path: string, text: string) => Promise<unknown>;
    ensureDirectory?: (path: string) => Promise<unknown>;
    maxBytes?: number;
  } = {},
) {
  const append = options.append ?? ((path, text) => appendFile(path, text, "utf8"));
  const ensureDirectory = options.ensureDirectory ?? ((path) => mkdir(path, { recursive: true }));
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  let queue: Array<{ path: string; text: string; bytes: number }> = [];
  let queuedBytes = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;

  async function drain() {
    while (queue.length > 0) {
      const batch = queue;
      queue = [];
      queuedBytes = 0;
      // 合并连续同文件记录，同时保留跨日/数据目录切换的入队顺序。
      for (let index = 0; index < batch.length;) {
        const path = batch[index]!.path;
        const lines: string[] = [];
        while (index < batch.length && batch[index]!.path === path) {
          lines.push(batch[index++]!.text);
        }
        if (dropped > 0) {
          lines.push(
            `[warn] [main-log] ${dropped} file log records omitted while the queue was full; console output retained.\n`,
          );
          dropped = 0;
        }
        try {
          await ensureDirectory(dirname(path));
          await append(path, lines.join(""));
        } catch {
          // 与原 logger 一致：磁盘写入失败不能中断业务；下一批仍可正常写入。
        }
      }
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!draining) {
      draining = drain().finally(() => {
        draining = undefined;
        // drain 结束到 finally 之间仍可能有微任务入队，不能遗留未调度的日志。
        if (queue.length > 0) void flush();
      });
    }
    return draining;
  }

  return {
    enqueue(path: string, text: string) {
      const bytes = Buffer.byteLength(text);
      if (queuedBytes + bytes > maxBytes) {
        dropped += 1;
        return;
      }
      queue.push({ path, text, bytes });
      queuedBytes += bytes;
      if (!timer && !draining) {
        timer = setTimeout(() => {
          void flush();
        }, 25);
        timer.unref();
      }
    },
    flush,
    async flushBeforeExit(timeoutMs = 1000): Promise<void> {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          flush(),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
