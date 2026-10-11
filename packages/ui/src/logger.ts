import {
  formatLogPrefix,
  isApplicationLogLevelEnabled,
  safeLogMessage,
  serializeLogValue,
} from "@zcode/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

type DesktopLogBridgeWindow = Window & {
  zcode?: {
    log?: (level: LogLevel, args: unknown[]) => void;
  };
};

const consoleFns: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function isLoggerLevelEnabled(level: LogLevel): boolean {
  // 用户环境是唯一级别来源；测试的显式禁用仍保留，生产/离线不再覆盖 DEBUG。
  return (
    (globalThis as typeof globalThis & { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean })
      .__ZCODE_RENDERER_DISABLE_LOGGING__ !== true && isApplicationLogLevelEnabled(level)
  );
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (!isLoggerLevelEnabled(level)) return;
  const message = safeLogMessage(args.map(serializeLogValue).join(" "));
  try {
    consoleFns[level](formatLogPrefix("ui"), message);
  } catch {
    // 控制台自身失败不影响业务，也不能阻止既有桌面日志出口。
  }
  if (typeof window !== "undefined") {
    try {
      (window as DesktopLogBridgeWindow).zcode?.log?.(level, [message]);
    } catch {
      // IPC/窗口关闭等日志故障不能改变原操作结果。
    }
  }
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => log("info", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
  },
  /** 保留既有关联 API，不增加新的跨文件关联机制。 */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/** 保留内存诊断的既有桌面出口；同样服从统一 INFO 阈值。 */
export function logMemoryDiagnostics(line: string): void {
  if (!isLoggerLevelEnabled("info")) return;
  if (typeof window !== "undefined") {
    const bridge = (window as DesktopLogBridgeWindow).zcode?.log;
    if (bridge) {
      try {
        bridge("info", [safeLogMessage(line)]);
      } catch {
        // 诊断出口不替换业务结果。
      }
      return;
    }
  }
  log("info", line);
}
