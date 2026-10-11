// 适配器唯一日志出口：stderr JSON；stdout 始终只承载协议。
import { AsyncLocalStorage } from "node:async_hooks";
import { isApplicationLogLevelEnabled, redactFeedbackText } from "@zcode/shared";
import { installDiagnosticSink, type DiagnosticLevel } from "../app/diagnostics.js";

const contexts = new AsyncLocalStorage<Readonly<Record<string, unknown>>>();
const emptyContext: Readonly<Record<string, unknown>> = Object.freeze({});
const MAX_STRING = 1024;
const MAX_LINE_BYTES = 16 * 1024;
const reserved: Record<string, true> = {
  ts: true,
  level: true,
  scope: true,
  message: true,
  pid: true,
  event: true,
};
const correlation: Record<string, true> = {
  requestId: true,
  commandId: true,
  inputId: true,
  traceId: true,
  sessionId: true,
  coreInstanceId: true,
  ompRequestId: true,
  peerPid: true,
};
const privateBody: Record<string, true> = {
  question: true,
  questions: true,
  answer: true,
  answers: true,
  selectedoptions: true,
  custominput: true,
  prefill: true,
  attachments: true,
  rawframe: true,
  frames: true,
};

function context(): Readonly<Record<string, unknown>> {
  return contexts.getStore() ?? emptyContext;
}
function run<T>(fields: Record<string, unknown>, callback: () => T): T {
  let next: Readonly<Record<string, unknown>>;
  try {
    next = Object.freeze({ ...context(), ...fields });
  } catch {
    return callback();
  }
  return contexts.run(next, callback);
}

function emit(
  level: DiagnosticLevel,
  message: string,
  fields?: Record<string, unknown>,
  event?: string,
): void {
  if (!isApplicationLogLevelEnabled(level)) return;
  try {
    let truncated = false;
    const bound = (value: unknown, depth: number): unknown => {
      if (value instanceof Error)
        return {
          errorType: value.name,
          error: bound(value.message, depth + 1),
          errorCode: bound((value as Error & { code?: unknown }).code, depth + 1),
        };
      if (typeof value === "string") {
        // 不切开凭据再脱敏；过大文本直接舍弃，避免截断私钥/JSON 后留下秘密尾部。
        if (value.length > 8192) {
          truncated = true;
          return "[TRUNCATED]";
        }
        const safe = redactFeedbackText(value, { diagnostic: true });
        if (safe.length <= MAX_STRING) return safe;
        truncated = true;
        return `${safe.slice(0, MAX_STRING)}[TRUNCATED]`;
      }
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (value === undefined) return undefined;
      if (depth >= 4) {
        truncated = true;
        return "[TRUNCATED]";
      }
      if (Array.isArray(value)) {
        if (value.length > 16) truncated = true;
        return value.slice(0, 16).map((item) => bound(item, depth + 1));
      }
      if (typeof value === "object") {
        const result: Record<string, unknown> = Object.create(null);
        let count = 0;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (++count > 32) {
            truncated = true;
            break;
          }
          if (key.length > 128) {
            truncated = true;
            continue;
          }
          result[key] = Object.hasOwn(privateBody, key.replace(/[^a-z0-9]/gi, "").toLowerCase())
            ? "[REDACTED]"
            : bound((value as Record<string, unknown>)[key], depth + 1);
        }
        return result;
      }
      return `[${typeof value}]`;
    };
    const raw: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const source of [fields, context()]) {
      if (!source) continue;
      // 先保留已知身份，字段预算耗尽也不能串掉异步请求。
      for (const key in correlation) {
        if (!Object.hasOwn(source, key) || Object.hasOwn(raw, key)) continue;
        raw[key] = bound(source[key], 0);
        if (typeof raw[key] === "string" && (raw[key] as string).length > 256) {
          raw[key] = (raw[key] as string).slice(0, 256);
          truncated = true;
        }
      }
      for (const key in source) {
        if (!Object.hasOwn(source, key)) continue;
        if (Object.hasOwn(raw, key)) continue;
        if (Object.hasOwn(reserved, key)) continue;
        if (++count > 64) {
          truncated = true;
          break;
        }
        if (key.length > 128) {
          truncated = true;
          continue;
        }
        const value = source[key];
        if (key === "error" && value instanceof Error) {
          raw.error = bound(value.message, 0);
          raw.errorType = bound(value.name, 0);
          raw.errorCode = bound((value as Error & { code?: unknown }).code, 0);
        } else {
          raw[key] = Object.hasOwn(privateBody, key.replace(/[^a-z0-9]/gi, "").toLowerCase())
            ? "[REDACTED]"
            : bound(value, 0);
        }
      }
    }
    // 对 details 和文本内容脱敏，不把 message/event/身份外层作为诊断正文遮掉。
    const safe = JSON.parse(
      redactFeedbackText(JSON.stringify(raw), { diagnostic: true }),
    ) as Record<string, unknown>;
    let safeMessage = redactFeedbackText(message.length > 8192 ? "[TRUNCATED]" : message, {
      diagnostic: true,
    });
    if (message.length > 8192 || safeMessage.length > MAX_STRING) truncated = true;
    safeMessage = safeMessage.slice(0, MAX_STRING);
    const candidate = event ?? (typeof fields?.event === "string" ? fields.event : undefined);
    const safeEvent =
      candidate && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(candidate) ? candidate : undefined;
    const identity = {
      ts: Date.now(),
      level,
      scope: "omp-agent",
      message: safeMessage,
      pid: process.pid,
      ...(safeEvent ? { event: safeEvent } : {}),
    };
    let record: Record<string, unknown> = {
      ...safe,
      ...identity,
      ...(truncated ? { truncated: true } : {}),
    };
    let line = JSON.stringify(record);
    // 行预算超限只删除 details，不能切断 JSON 或丢失原始身份。
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      for (const key of Object.keys(safe).reverse()) {
        if (Object.hasOwn(correlation, key)) continue;
        delete record[key];
        record = { ...record, truncated: true };
        line = JSON.stringify(record);
        if (Buffer.byteLength(line) <= MAX_LINE_BYTES) break;
      }
    }
    process.stderr.write(`${line}\n`, () => {
      /* 异步写失败不进入业务或递归日志。 */
    });
  } catch {
    /* 循环对象/getter/IO 等诊断失败均不可改变业务。 */
  }
}

// stderr 错误事件不能让一次日志写失败变成宿主 uncaught exception。
process.stderr.on("error", () => {
  /* 不递归报告出口自身错误。 */
});
installDiagnosticSink({
  emit: (level, event, fields) => emit(level, event, fields, event),
  run,
  context,
});
export const logger = {
  debug: (message: string, details?: Record<string, unknown>): void =>
    emit("debug", message, details),
  info: (message: string, details?: Record<string, unknown>): void =>
    emit("info", message, details),
  warn: (message: string, details?: Record<string, unknown>): void =>
    emit("warn", message, details),
  error: (message: string, details?: Record<string, unknown>): void =>
    emit("error", message, details),
  run,
  context,
};
