import type { ZCodeAgentInteractionEvent } from "@zcode/shared";
import { ompHistoryTimestamp } from "./OmpSubagentHistory.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const string = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** OMP 批量通知按实际 job 段落提取；不能把整批正文冒充每个子代理自己的结果。 */
export function ompAsyncResultEvents(
  value: unknown,
  context: {
    agentId: string;
    entryKey: string;
    source: "live" | "history";
    knownChild: (parentId: string, rawId: string) => string | undefined;
  },
): ZCodeAgentInteractionEvent[] {
  const custom = object(value);
  if (custom?.customType !== "async-result" || custom.display === false) return [];
  const details = object(custom.details);
  const jobs = Array.isArray(details?.jobs) ? details.jobs : [];
  const content =
    typeof custom.content === "string"
      ? custom.content
      : Array.isArray(custom.content)
        ? custom.content.map((part) => string(object(part)?.text) ?? "").join("\n")
        : "";
  const timestamp = ompHistoryTimestamp(custom.timestamp);
  const events: ZCodeAgentInteractionEvent[] = [];
  for (const value of jobs) {
    const job = object(value);
    if (job?.type !== "task") continue;
    const jobId = string(job.jobId);
    const rawId = string(job.agentUrlId) ?? jobId;
    const from = rawId ? context.knownChild(context.agentId, rawId) : undefined;
    if (!rawId || !from) continue;
    const section =
      jobId && jobs.length > 1
        ? new RegExp(
            `(?:^|\\n)── Job ${escaped(jobId)}(?: \\([^\\n]*\\))? ──\\r?\\n([\\s\\S]*?)(?=\\r?\\n── Job |\\r?\\n</system-notice>|$)`,
            "u",
          ).exec(content)?.[1]
        : undefined;
    const schema = object(job.schema);
    const body =
      string(job.resultText) ??
      section ??
      (jobs.length === 1 ? content : schema?.data !== undefined ? JSON.stringify(schema.data) : "");
    if (!body) continue;
    events.push({
      // 修复依据：核心把同一交付的 timestamp 原样落 journal；live/history 共用此键。
      // 缺时间时仅保留原条目身份，不用读取时刻或时间容差猜测同一消息。
      eventId: `async-result:${context.agentId}:${timestamp ?? context.entryKey}:${rawId}`,
      kind: "task_result",
      fromAgentId: from,
      toAgentId: context.agentId,
      body,
      ...(timestamp !== undefined ? { timestamp } : {}),
      timeBasis: timestamp === undefined ? "unknown" : "recorded",
      source: context.source,
    });
  }
  return events;
}
