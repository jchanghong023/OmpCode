// app 只分发诊断事实；上下文、脱敏与 stderr IO 均由适配器安装的 sink 持有。
export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export interface DiagnosticSink {
  emit(level: DiagnosticLevel, event: string, fields?: Record<string, unknown>): void;
  run<T>(context: Record<string, unknown>, callback: () => T): T;
  context(): Readonly<Record<string, unknown>>;
}

let sink: DiagnosticSink | undefined;
const emptyContext: Readonly<Record<string, unknown>> = Object.freeze({});
export function installDiagnosticSink(next: DiagnosticSink): void {
  sink = next;
}
function emit(level: DiagnosticLevel, event: string, fields?: Record<string, unknown>): void {
  // 日志出口异常不能改变业务返回或异常传播。
  try {
    sink?.emit(level, event, fields);
  } catch {
    /* 诊断失败不递归记录。 */
  }
}
export const diagnostics = {
  debug: (event: string, fields?: Record<string, unknown>): void => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>): void => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>): void => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>): void => emit("error", event, fields),
  run<T>(context: Record<string, unknown>, callback: () => T): T {
    return sink ? sink.run(context, callback) : callback();
  },
  context(): Readonly<Record<string, unknown>> {
    try {
      return sink?.context() ?? emptyContext;
    } catch {
      return emptyContext;
    }
  },
};
