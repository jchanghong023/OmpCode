import {
  formatLogPrefix,
  isApplicationLogLevelEnabled,
  safeLogMessage,
  serializeLogValue,
  type TraceId,
} from "@zcode/shared";
interface ServiceLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ServiceLogger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export function createServiceLogger(
  scope: string,
  options?: {
    pid?: number;
    sink?: ServiceLogSink;
  },
): ServiceLogger {
  const pid = options?.pid ?? process.pid;
  const sink = options?.sink ?? console;
  // 服务层日志保持独立于 ZCode Agent runtime；级别唯一由共享 JCH_LOG_LEVEL 判定。
  function write(
    level: "debug" | "info" | "warn" | "error",
    traceId: TraceId | undefined,
    ...args: unknown[]
  ): void {
    if (!isApplicationLogLevelEnabled(level)) return;
    const source = traceId ? `${scope}][trace:${traceId}` : scope;
    try {
      const consoleFn =
        level === "error"
          ? sink.error
          : level === "warn"
            ? sink.warn
            : level === "debug"
              ? (sink.debug ?? sink.log)
              : sink.log;
      const prefix = formatLogPrefix(source, pid);
      if (args.length === 0) {
        consoleFn(prefix);
        return;
      }
      const message = safeLogMessage(args.map(serializeLogValue).join(" "));
      consoleFn(prefix, message);
    } catch {
      reportServiceLoggerSinkFailure();
    }
  }

  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}

let serviceLoggerSinkFailureReported = false;

// stderr 的异步 error 也属于日志出口故障，不得杀掉业务进程。
process.stderr.on("error", () => {});

function reportServiceLoggerSinkFailure(): void {
  if (serviceLoggerSinkFailureReported) return;
  serviceLoggerSinkFailureReported = true;
  try {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        scope: "service-log",
        pid: process.pid,
        event: "service_log_sink_failed",
        message: "log sink failed",
      })}\n`,
      () => {},
    );
  } catch {
    // 最终出口自身失效时停止，不递归记录，也不改变业务结果。
  }
}
