// 适配器进程日志：仅写 stderr（stdout 是协议通道）。级别：debug/info/warn/error。

function emit(level: string, message: string, details?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: "omp-agent",
    message,
    ...details,
  });
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, details?: Record<string, unknown>) => emit("debug", message, details),
  info: (message: string, details?: Record<string, unknown>) => emit("info", message, details),
  warn: (message: string, details?: Record<string, unknown>) => emit("warn", message, details),
  error: (message: string, details?: Record<string, unknown>) => emit("error", message, details),
};
