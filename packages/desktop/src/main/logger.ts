import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getApplicationLogLevel, isApplicationLogLevelEnabled } from "@zcode/shared/log-level";
import {
  safeLogMessage as safeMessage,
  serializeLogValue as serialize,
} from "@zcode/shared/log-format";
import { redactFeedbackText, ZCODE_VERSION } from "@zcode/shared";
import {
  appendLogRecords,
  cleanupExpiredLogFiles,
  LOG_RETENTION_DAYS,
  LogRetentionError,
  prepareLogFile,
} from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";
import { formatDate, mainLogContext } from "./mainLogFormatting.js";

// Main 是唯一文件 writer；初始化、写盘和保留期清理均异步，日志失败不得中断业务。
const MAIN_LOG_FLUSH_WINDOW_MS = 25;
const MAIN_LOG_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAIN_LOG_EXIT_FLUSH_BUDGET_MS = 1000;
const MAIN_LOG_MAX_BATCH_LINES = 256;
// 日期文件会被重启后的进程继续追加；启动时固定唯一标识，PID 复用也不混写。
const MAIN_LOG_RUN_ID = `${Date.now()}-${process.pid}-${randomUUID()}`;

type LogLevel = "debug" | "info" | "warn" | "error";
interface PendingLogLine {
  date: string;
  line: string;
  bytes: number;
}

const pendingLines: PendingLogLine[] = [];
const reportedFailures = new Set<string>();
let queuedBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let drainTask: Promise<void> | null = null;
let droppedLines = 0;
let activeLogDir: string | undefined;
let fallbackAttempted = false;
let lastSinkFailure: Record<string, unknown> = {};
let lastRetentionDir: string | undefined;
let lastRetentionDate: string | undefined;
let exitLogDeadline: number | undefined;
let exitDrainTask: Promise<void> | undefined;
const isolatedLogDir =
  process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;

function ignoreBrokenPipeStreamError(error: Error): void {
  // 输出管道失效也是日志自身故障，不让异步 stream error 杀掉业务；直接报告且不递归。
  if (!("code" in error) || error.code !== "EPIPE")
    reportSinkFailure("console_stream", undefined, error);
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, line: string): void {
  try {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // 控制台失效不能递归使用 logger，也不能阻止文件队列继续排空。
  }
}
function reportSinkFailure(
  stage: string,
  logDir: string | undefined,
  error: unknown,
  elapsedMs: number = 0,
): void {
  const key = `${stage}:${logDir ?? ""}`;
  if (reportedFailures.has(key)) return;
  reportedFailures.add(key);
  lastSinkFailure = {
    failedStage: stage,
    failedLogDir: logDir,
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode: error && typeof error === "object" && "code" in error ? error.code : undefined,
  };
  const line = safeMessage(
    serialize({
      ts: new Date().toISOString(),
      level: "error",
      scope: "main-log",
      pid: process.pid,
      event: "main_log_sink_failed",
      stage,
      logDir,
      error,
      elapsedMs,
    }),
  );
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // 最终报告出口本身失败时停止，不调用 logger、不开另一文件、不重试。
  }
}

function fallbackLogDir(): string {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"),
      "OmpCode",
      "logs",
    );
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Logs", "OmpCode");
  return join(
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
    "OmpCode",
    "logs",
  );
}

async function appendLogFile(filePath: string, text: string): Promise<void> {
  maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
  await appendFile(filePath, text);
}

async function renameLogFile(source: string, destination: string): Promise<void> {
  maybeThrowInjectedFsFault({ operation: "rename", path: source });
  await rename(source, destination);
}

function logFileStem(date: string): string {
  return `${date}.${MAIN_LOG_RUN_ID}`;
}

async function retainLogFiles(
  logDir: string,
  date: string,
  reserveActiveFile: boolean,
): Promise<void> {
  if (!reserveActiveFile && lastRetentionDir === logDir && lastRetentionDate === date) return;
  const result = await cleanupExpiredLogFiles(logDir, {
    activeFileName: `${logFileStem(date)}.log`,
    reserveActiveFile,
  });
  if (result.failedFiles.length > 0) throw new LogRetentionError(result.failedFiles);
  lastRetentionDir = logDir;
  lastRetentionDate = date;
}
async function prepareLogDir(logDir: string, stage: string): Promise<boolean> {
  const startedAt = Date.now();
  let phase = "directory_create";
  try {
    maybeThrowInjectedFsFault({ operation: "mkdir", path: logDir });
    await mkdir(logDir, { recursive: true });
    phase = "file_open";
    const date = formatDate(new Date());
    await prepareLogFile(
      logDir,
      logFileStem(date),
      appendLogFile,
      renameLogFile,
      (reserveActiveFile) => retainLogFiles(logDir, date, reserveActiveFile),
    );
    activeLogDir = logDir;
    return true;
  } catch (error) {
    const failureStage =
      error instanceof LogRetentionError ? `${stage}_retention` : `${stage}_${phase}`;
    reportSinkFailure(failureStage, logDir, error, Date.now() - startedAt);
    return false;
  }
}

async function activateFallback(): Promise<boolean> {
  // 指定测试目录绝不逃逸至用户数据；正常路径只尝试一次回退，不无限重试。
  if (isolatedLogDir || fallbackAttempted) return false;
  fallbackAttempted = true;
  try {
    const directory = fallbackLogDir();
    if (directory === activeLogDir) return false;
    return await prepareLogDir(directory, "fallback_initialize");
  } catch (error) {
    reportSinkFailure("fallback_resolve", undefined, error);
    return false;
  }
}

async function initializeLogDirectory(): Promise<void> {
  const startedAt = Date.now();
  try {
    const intended = isolatedLogDir || join(getAppConfigDir(), "logs");
    if (!(await prepareLogDir(intended, "initialize")) && !(await activateFallback())) return;
  } catch (error) {
    reportSinkFailure("directory_resolve", undefined, error);
    if (!(await activateFallback())) return;
  }
  if (fallbackAttempted)
    sinkEvent("warn", "main_log_fallback", {
      ...lastSinkFailure,
      stage: "initialize",
      elapsedMs: Date.now() - startedAt,
    });
  sinkEvent("info", "application_started", {
    application: "OmpCode",
    mode: process.env.ZCODE_ENV || process.env.NODE_ENV || "development",
    level: getApplicationLogLevel(),
    version: ZCODE_VERSION,
    elapsedMs: Date.now() - startedAt,
  });
}

async function appendBatch(date: string, batch: readonly PendingLogLine[]): Promise<boolean> {
  if (!activeLogDir) return false;
  const startedAt = Date.now();
  const originalDir = activeLogDir;
  const appendToDirectory = (logDir: string) =>
    appendLogRecords(
      logDir,
      logFileStem(date),
      batch,
      appendLogFile,
      renameLogFile,
      (reserveActiveFile) => retainLogFiles(logDir, date, reserveActiveFile),
    );
  try {
    await appendToDirectory(originalDir);
    return true;
  } catch (error) {
    const stage = error instanceof LogRetentionError ? "retention" : "append";
    const details =
      error instanceof LogRetentionError
        ? { failedFiles: error.failedFiles, retentionDays: LOG_RETENTION_DAYS }
        : error;
    reportSinkFailure(stage, originalDir, details, Date.now() - startedAt);
    if (await activateFallback()) {
      try {
        await appendToDirectory(activeLogDir!);
        sinkEvent("warn", "main_log_recovered", {
          ...lastSinkFailure,
          stage: "append",
          fallback: true,
          elapsedMs: Date.now() - startedAt,
        });
        return true;
      } catch (fallbackError) {
        reportSinkFailure(
          fallbackError instanceof LogRetentionError ? "fallback_retention" : "fallback_append",
          activeLogDir,
          fallbackError instanceof LogRetentionError
            ? { failedFiles: fallbackError.failedFiles, retentionDays: LOG_RETENTION_DAYS }
            : fallbackError,
          Date.now() - startedAt,
        );
      }
    }
    // 最终文件失败后仅保留控制台，不逐条重试、不重新初始化、不递归记录失败。
    activeLogDir = undefined;
    return false;
  }
}

function scheduleFlush(): void {
  if (flushTimer || drainTask) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void drainLogLines().catch((error) => reportSinkFailure("drain", activeLogDir, error));
  }, MAIN_LOG_FLUSH_WINDOW_MS);
  flushTimer.unref?.();
}

function cancelScheduledFlush(): void {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = undefined;
}

async function drainLogLines(): Promise<void> {
  if (drainTask) return drainTask;
  drainTask = (async () => {
    try {
      await initialization;
      while (pendingLines.length > 0) {
        const first = pendingLines[0]!;
        let batchSize = 0;
        while (batchSize < MAIN_LOG_MAX_BATCH_LINES && pendingLines[batchSize]?.date === first.date)
          batchSize += 1;
        const batch = pendingLines.splice(0, batchSize);
        const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
        try {
          await appendBatch(first.date, batch);
        } catch (error) {
          reportSinkFailure("drain", activeLogDir, error);
        } finally {
          queuedBytes -= bytes;
        }
      }
    } catch (error) {
      reportSinkFailure("drain", activeLogDir, error);
      queuedBytes -= pendingLines.reduce((total, entry) => total + entry.bytes, 0);
      pendingLines.length = 0;
    }
  })().finally(() => {
    drainTask = null;
    if (pendingLines.length > 0) scheduleFlush();
  });
  return drainTask;
}

function enqueue(
  level: LogLevel,
  source: string,
  message: string,
  now: Date,
  sourcePid: number | string = process.pid,
  sourceTs?: string,
): void {
  const ts = sourceTs ?? now.toISOString();
  const line = `[${ts}] [${level}] [pid:${sourcePid}] [${source}] ${message}\n`;
  safeConsoleWrite(level, line.trimEnd());
  const bytes = Buffer.byteLength(line);
  if (queuedBytes + bytes > MAIN_LOG_MAX_QUEUED_BYTES) {
    droppedLines += 1;
    return;
  }
  const date = formatDate(now);
  if (!isApplicationLogLevelEnabled("warn")) {
    droppedLines = 0;
  } else if (droppedLines > 0) {
    const notice = `[${now.toISOString()}] [warn] [pid:${process.pid}] [main] log buffer dropped ${droppedLines} lines\n`;
    const noticeBytes = Buffer.byteLength(notice);
    if (queuedBytes + bytes + noticeBytes <= MAIN_LOG_MAX_QUEUED_BYTES) {
      pendingLines.push({ date, line: notice, bytes: noticeBytes });
      queuedBytes += noticeBytes;
      droppedLines = 0;
    }
  }
  pendingLines.push({ date, line, bytes });
  queuedBytes += bytes;
  scheduleFlush();
}

function write(level: LogLevel, source: string, ...args: unknown[]): void {
  if (!isApplicationLogLevelEnabled(level)) return;
  const now = new Date();
  const context = mainLogContext(args, source, now, process.pid);
  enqueue(
    level,
    context.source,
    safeMessage(args.map(serialize).join(" ")),
    now,
    context.pid,
    context.timestamp,
  );
}

function sinkEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (!isApplicationLogLevelEnabled(level)) return;
  const now = new Date();
  const record = JSON.parse(
    redactFeedbackText(
      serialize({
        elapsedMs: 0,
        ...fields,
        ts: now.toISOString(),
        level,
        scope: "main",
        pid: process.pid,
        event,
      }),
    ),
  ) as Record<string, unknown>;
  // 实际路径是 writer 持有的可信元数据，不是正文；脱敏用户/错误文本后独立追加。
  record.logFile = activeLogDir ? join(activeLogDir, `${logFileStem(formatDate(now))}.log`) : null;
  enqueue(level, "main", JSON.stringify(record).replace(/[\u2028\u2029]/g, "\\n"), now);
}

export async function flushMainLogs(): Promise<void> {
  // Host 收尾与最终退出共用总 1s 预算；普通 logger.flush 不产生退出事件。
  if (!exitDrainTask) {
    exitLogDeadline = Date.now() + MAIN_LOG_EXIT_FLUSH_BUDGET_MS;
    cancelScheduledFlush();
    exitDrainTask = (async () => {
      await initialization;
      sinkEvent("info", "application_stopping");
      await drainLogLines();
      sinkEvent("info", "application_stopped", {
        elapsedMs: Date.now() - (exitLogDeadline! - MAIN_LOG_EXIT_FLUSH_BUDGET_MS),
      });
      cancelScheduledFlush();
      await drainLogLines();
    })().catch((error) => {
      reportSinkFailure("exit_drain", activeLogDir, error);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => {
      await exitDrainTask;
      cancelScheduledFlush();
      await drainLogLines();
    })(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(exitLogDeadline! - Date.now(), 0));
      timer.unref?.();
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/** 唯一桌面文件出口；正常路径不变，显式 E2E 目录隔离，初始化失败只回退一次。 */
export const logger = {
  debug: (...args: unknown[]) => write("debug", "main", ...args),
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
  flush: () => {
    cancelScheduledFlush();
    return drainLogLines();
  },
};

const initialization = initializeLogDirectory().catch((error) => {
  reportSinkFailure("initialize", activeLogDir, error);
});
