/** 持久记录只证明历史终态；没有终态依据时不能恢复成当前运行中。 */
export type OmpHistoryStatus = "success" | "failed" | "cancelled" | "unknown";
export interface OmpHistoryOutcome {
  status: OmpHistoryStatus;
  at?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function ompHistoryTimestamp(value: unknown): number | undefined {
  const time =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 ? Math.trunc(time) : undefined;
}

/** Only execution facts; requested models and role aliases are not serving identities. */
export function ompResolvedSubagentModel(value: unknown): string | undefined {
  const item = record(value);
  for (const candidate of [item?.resolvedModelIdentity, item?.resolvedModel]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function modelIdentity(value: unknown): string | undefined {
  const item = record(value);
  if (typeof item?.model !== "string" || !item.model.trim()) return undefined;
  return typeof item.provider === "string" && item.provider.trim()
    ? `${item.provider}/${item.model}`
    : item.model;
}

/** Bare model_changed is only a notification, not a model identity. */
export function ompSubagentEventModel(value: unknown): string | undefined {
  const event = record(value);
  if (event?.type === "model_changed") return modelIdentity(event);
  if (!["message_start", "message_update", "message_end"].includes(String(event?.type)))
    return undefined;
  const message = record(event?.message);
  return message?.role === "assistant" ? modelIdentity(message) : undefined;
}

export function ompHistoryModel(
  entries: readonly unknown[],
): { model: string; at?: number } | undefined {
  let latest: { model: string; at?: number } | undefined;
  for (const entry of entries) {
    const item = record(entry);
    const message = record(item?.message);
    const model =
      item?.type === "model_change" && (item.role === undefined || item.role === "default")
        ? modelIdentity(item)
        : message?.role === "assistant"
          ? modelIdentity(message)
          : undefined;
    if (!model) continue;
    const at = ompHistoryTimestamp(message?.timestamp ?? item?.timestamp);
    if (latest?.at !== undefined && at !== undefined && at < latest.at) continue;
    latest = { model, at };
  }
  return latest;
}

export function ompHistoricalStatus(value: unknown): OmpHistoryStatus {
  if (value === "completed" || value === "success" || value === "parked") return "success";
  if (value === "failed" || value === "error") return "failed";
  if (value === "aborted" || value === "cancelled" || value === "interrupted") return "cancelled";
  return "unknown";
}

/** 同一子代理可被消息唤醒多次；最新活动必须覆盖此前 yield/回复的终态。 */
export function ompHistoryOutcome(entries: readonly unknown[]): OmpHistoryOutcome {
  let outcome: OmpHistoryOutcome = { status: "unknown" };
  for (const entry of entries) {
    const item = record(entry);
    const message = record(item?.message);
    if (
      item?.type === "custom_message" &&
      ["irc:incoming", "async-result"].includes(String(item.customType))
    ) {
      outcome = { status: "unknown", at: ompHistoryTimestamp(item.timestamp) };
      continue;
    }
    if (!message) continue;
    const at = ompHistoryTimestamp(message.timestamp ?? item?.timestamp);
    if (message.role === "user") {
      outcome = { status: "unknown", at };
    } else if (message.role === "assistant") {
      // 修复依据：stopReason 是核心落盘的执行结果；最终正文的“完成”等词不能作为状态依据。
      outcome = {
        status:
          message.stopReason === "stop"
            ? "success"
            : message.stopReason === "error"
              ? "failed"
              : message.stopReason === "aborted"
                ? "cancelled"
                : "unknown",
        at,
      };
    } else if (message.role === "toolResult" && message.toolName === "yield") {
      const details = record(message.details);
      // 本机 OMP YieldTool.shouldTerminate：无 type 或字符串 type 是终态；
      // 只有成功的非空字符串数组属于增量，完整 workpool 或 aborted 仍结束。
      const incremental =
        details?.status === "success" &&
        Array.isArray(details.type) &&
        details.type.length > 0 &&
        details.type.every((item) => typeof item === "string");
      if (
        message.isError !== true &&
        details &&
        (details.status === "success" || details.status === "aborted") &&
        (details.complete === true || !incremental)
      ) {
        outcome = {
          status: ompHistoricalStatus(details.status),
          at,
        };
      }
    }
  }
  return outcome;
}
