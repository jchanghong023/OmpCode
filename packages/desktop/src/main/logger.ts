import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

// 无 GPU 桌面的交互与日志共用 Main 事件循环；每条同步 mkdir/append 在慢盘上会阻塞 UI。
// 文件日志走本模块内的唯一有界异步队列（不做平台分叉），仍按原路径和日期记录。
//
// 队列的时间/容量上限必须显式定义为常量并被回归测试引用
// （centos7-performance.md：参考值 25ms 合批窗口与 4MiB 队列上限、退出 1 秒排空预算）。
/** 同一轮日志的合批窗口：窗口内同文件行合并成一次 appendFile，持续写入不能被无限延期。 */
export const MAIN_LOG_FLUSH_WINDOW_MS = 25;
/** 队列容量上限（不含正在写的一批）：超限行计数并在后续文件记录中报告，console 仍可见。 */
export const MAIN_LOG_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** 正常退出排空共享预算：Host 清理后与最终退出的全部 flush 共用，不逐次累加等待。 */
export const MAIN_LOG_EXIT_FLUSH_BUDGET_MS = 1000;
/** 单文件单批最大行数，防止一次性超大 append 阻塞事件循环。 */
const MAIN_LOG_MAX_BATCH_LINES = 256;

let exitLogDeadline: number | undefined;
export async function flushMainLogs(): Promise<void> {
  // Host 收尾和最终退出可能都调用此处，共用总预算，不能逐次累加退出等待。
  exitLogDeadline ??= Date.now() + MAIN_LOG_EXIT_FLUSH_BUDGET_MS;
  cancelScheduledFlush();
  // 超过共享预算即放行退出；强杀、磁盘失败或超时不保证日志落盘（需求明确允许）。
  await Promise.race([
    drainLogLines(),
    new Promise<void>((resolve) => {
      const remaining = Math.max(exitLogDeadline! - Date.now(), 0);
      const timer = setTimeout(resolve, remaining);
      timer.unref?.();
    }),
  ]);
}

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// 启动时确保日志目录存在
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO / dev runner 结束后可能先关闭 stdout/stderr 管道，随后主进程日志还在刷新。
  // stream error 是异步事件，try/catch 包 console.log 不一定兜得住；这里统一吞掉 EPIPE。
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  if (process.env.OMPCODE_CENTOS7_LOCAL_ONLY === "1" && level !== "error") return;
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // dev 脚本或父终端退出后，Electron main 的 stdout/stderr 管道可能已关闭。
    // 这时 console.* 会抛 EPIPE，不能让日志输出反过来杀掉主进程；文件日志仍会继续写入。
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface PendingLogLine {
  filePath: string;
  line: string;
  bytes: number;
}

const pendingLines: PendingLogLine[] = [];
let queuedBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let drainTask: Promise<void> | null = null;
let droppedLines = 0;

function scheduleFlush(): void {
  if (flushTimer || drainTask) return;
  // 合批窗口：先攒一批再落盘；unref 不阻塞进程自然退出，退出路径走显式 flush。
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void drainLogLines();
  }, MAIN_LOG_FLUSH_WINDOW_MS);
  flushTimer.unref?.();
}

function cancelScheduledFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}

async function drainLogLines(): Promise<void> {
  if (drainTask) return drainTask;
  drainTask = (async () => {
    while (pendingLines.length > 0) {
      const first = pendingLines[0]!;
      let batchSize = 0;
      while (
        batchSize < MAIN_LOG_MAX_BATCH_LINES &&
        pendingLines[batchSize]?.filePath === first.filePath
      )
        batchSize += 1;
      const batch = pendingLines.splice(0, batchSize);
      const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
      try {
        maybeThrowInjectedFsFault({ operation: "appendFile", path: first.filePath });
        await appendFile(first.filePath, batch.map((entry) => entry.line).join(""));
      } catch (error) {
        // 日志文件失败不影响应用；控制台仍可见错误，且不在 logger 内递归写日志。
        safeConsoleWrite("warn", "[main-log] file append failed", error);
      } finally {
        queuedBytes -= bytes;
      }
    }
  })().finally(() => {
    drainTask = null;
    if (pendingLines.length > 0) scheduleFlush();
  });
  return drainTask;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  // CentOS 7 只保留错误日志；在格式化、打印和文件入队之前退出，避免无 GPU 桌面的额外 IO。
  if (process.env.OMPCODE_CENTOS7_LOCAL_ONLY === "1" && level !== "error") return;
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const filePath = join(LOG_DIR, `${formatDate(now)}.log`);

  // 同时保留 console 输出，方便开发调试；console 也加时间戳和 PID，与文件格式对齐
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

  const bytes = Buffer.byteLength(line);
  if (queuedBytes + bytes > MAIN_LOG_MAX_QUEUED_BYTES) {
    droppedLines += 1;
    return;
  }
  if (droppedLines > 0) {
    const notice = `[${ts}] [warn] [pid:${pid}] [main] log buffer dropped ${droppedLines} lines\n`;
    const noticeBytes = Buffer.byteLength(notice);
    if (queuedBytes + bytes + noticeBytes <= MAIN_LOG_MAX_QUEUED_BYTES) {
      pendingLines.push({ filePath, line: notice, bytes: noticeBytes });
      queuedBytes += noticeBytes;
      droppedLines = 0;
    }
  }
  pendingLines.push({ filePath, line, bytes });
  queuedBytes += bytes;
  scheduleFlush();
}

/**
 * main 进程日志，默认写入 ~/.ompcode/v2/logs/YYYY-MM-DD.log；E2E 测试使用 worker 专属目录。
 * 同时保留 console 输出方便开发调试
 */
export const logger = {
  // 高频 browser/CDP 等协议细节只在本地开发记录，避免生产日志量与命令流同数量级。
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** renderer 日志通过 IPC 传入后调用此方法写入同一文件 */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
  /** 显式立即排空（绕过合批窗口）；退出路径用 flushMainLogs 共享 1 秒预算。 */
  flush: () => {
    cancelScheduledFlush();
    return drainLogLines();
  },
};
