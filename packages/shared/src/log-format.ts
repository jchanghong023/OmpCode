import { redactFeedbackText } from "./feedbackPrivacy.js";

const LOG_MAX_MESSAGE_CHARS = 32 * 1024;

/**
 * 日志格式化工具
 *
 * 提供统一的时间戳和日志前缀格式化，供所有进程（main/host/server/renderer）使用。
 * 纯函数，无 Node.js 专有 API 依赖，浏览器环境安全。
 */

/**
 * 格式化时间戳为 "YYYY-MM-DD HH:mm:ss.mmm"
 */
export function formatTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${d} ${h}:${min}:${s}.${ms}`;
}

/**
 * 生成日志前缀，统一格式：
 * 有 PID: "[YYYY-MM-DD HH:mm:ss.mmm] [pid:12345] [source]"
 * 无 PID: "[YYYY-MM-DD HH:mm:ss.mmm] [source]"
 *
 * Node.js 进程传入 process.pid，浏览器端不传。
 */
export function formatLogPrefix(source: string, pid?: number): string {
  const ts = formatTimestamp();
  const pidPart = pid != null ? ` [pid:${pid}]` : "";
  return `[${ts}]${pidPart} [${source}]`;
}

/** 安全异常上下文与结构化字段序列化；诊断失败不得触发业务异常。 */
export function serializeLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return item.toString();
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        if (item instanceof Error) {
          return {
            name: item.name,
            message: item.message,
            stack: item.stack,
            code: "code" in item ? item.code : undefined,
            cause: "cause" in item ? item.cause : undefined,
          };
        }
        return item;
      }) ?? String(value)
    );
  } catch {
    return "[Unserializable log value]";
  }
}

/** 先完整脱敏再限长/转义，保证每条日志只有一个物理行。 */
export function safeLogMessage(text: string): string {
  const redacted = redactFeedbackText(text);
  const bounded =
    redacted.length > LOG_MAX_MESSAGE_CHARS
      ? `${redacted.slice(0, LOG_MAX_MESSAGE_CHARS)} [truncated]`
      : redacted;
  return bounded
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\u2028\u2029]/g, "\\n");
}
