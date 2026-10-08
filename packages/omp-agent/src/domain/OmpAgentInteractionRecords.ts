import type { ZCodeAgentInteractionAgent, ZCodeAgentInteractionEvent } from "@zcode/shared";
import { safeInteractionAgentId } from "./OmpInteractionIds.js";

export function interactionObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function interactionTimestamp(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
export const interactionChildId = (parent: string, id: string): string =>
  parent === "main" ? (id === "main" ? "agent:main" : id) : `${parent}/${id}`;

export interface InteractionSource {
  agentId: string;
  key: string;
  source: "live" | "history";
  entries: readonly unknown[];
}
export interface InteractionChild extends ZCodeAgentInteractionAgent {
  rawId: string;
  ancestry: string[];
}
export function childrenFromInteractionRecords(
  source: InteractionSource,
  ancestry: readonly string[],
): InteractionChild[] {
  const children = new Map<string, InteractionChild>();
  for (const entry of source.entries) {
    const record = interactionObject(entry);
    const message = interactionObject(record?.message);
    const details = interactionObject(message?.details);
    if (message?.role !== "toolResult") continue;
    if (message.toolName === "wait") {
      for (const value of Array.isArray(details?.jobs) ? details.jobs : []) {
        const job = interactionObject(value);
        const rawId = string(job?.agentUrlId) ?? string(job?.id);
        const status = string(job?.status);
        const id = rawId ? interactionChildId(source.agentId, rawId) : undefined;
        const child = id ? children.get(id) : undefined;
        // 只有已证明归属的 task job 结果能更新状态；同名 bash/eval 与主会话结束不作推断。
        if (job?.type === "task" && status && child) children.set(child.id, { ...child, status });
      }
      continue;
    }
    if (message.toolName !== "task") continue;
    for (const value of [
      ...(Array.isArray(details?.progress) ? details.progress : []),
      ...(Array.isArray(details?.results) ? details.results : []),
    ]) {
      const progress = interactionObject(value);
      const rawId = string(progress?.id);
      if (!rawId || !safeInteractionAgentId(rawId)) continue;
      const id = interactionChildId(source.agentId, rawId);
      children.set(id, {
        id,
        rawId,
        label: rawId,
        parentAgentId: source.agentId,
        known: true,
        ancestry: [...ancestry, rawId],
        ...(string(progress?.status) ? { status: String(progress?.status) } : {}),
      });
    }
  }
  return [...children.values()];
}

export interface InteractionObservation {
  event: ZCodeAgentInteractionEvent;
  origin: "incoming" | "relay" | "send" | "task";
  startTimestamp?: number;
  endTimestamp?: number;
}
export interface InteractionParseContext {
  resolveAgent: (rawId: string) => string;
  knownChild: (parentId: string, rawId: string) => string | undefined;
}

/** 原始结构字段才是通信依据；不解析 prompt 包装，也不把 user/steer 消息当代理发送。 */
export function observationsFromInteractionRecords(
  source: InteractionSource,
  context: InteractionParseContext,
): InteractionObservation[] {
  const observations: InteractionObservation[] = [];
  const calls = new Map<string, { args: Record<string, unknown>; timestamp?: number }>();
  const add = (
    event: ZCodeAgentInteractionEvent,
    origin: InteractionObservation["origin"],
    span?: { startTimestamp?: number; endTimestamp?: number },
  ) => observations.push({ event, origin, ...span });
  const incoming = (value: unknown, key: string, owner = source.agentId) => {
    const message = interactionObject(value);
    if (!message || message.display === false) return;
    const details = interactionObject(message.details);
    const customType = string(message.customType);
    if (customType !== "irc:incoming" && customType !== "irc:relay") return;
    const from = string(details?.from);
    const explicitTo = string(details?.to);
    const to = explicitTo ?? (customType === "irc:incoming" ? owner : undefined);
    const body = string(details?.body) ?? string(details?.message);
    if (!from || !to || body === undefined) return;
    const messageId = string(details?.id);
    const timestamp = interactionTimestamp(message.timestamp);
    add(
      {
        eventId: messageId ? `message:${messageId}` : `${source.key}:${key}`,
        kind: "message",
        fromAgentId: context.resolveAgent(from),
        toAgentId: explicitTo ? context.resolveAgent(to) : to,
        body,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(messageId ? { messageId } : {}),
        timeBasis:
          timestamp === undefined
            ? "unknown"
            : message.type === "custom_message"
              ? "recorded"
              : "sent",
        ...(string(details?.replyTo) ? { replyTo: String(details?.replyTo) } : {}),
        delivery: "observed",
        source: source.source,
      },
      customType === "irc:relay" ? "relay" : "incoming",
    );
  };
  for (let index = 0; index < source.entries.length; index += 1) {
    const record = interactionObject(source.entries[index]);
    if (!record) continue;
    const message = interactionObject(record.message);
    const entryKey = string(record.id) ?? `entry-${index}`;
    incoming(record.type === "custom_message" ? record : message, entryKey);
    if (!message) continue;
    const timestamp = interactionTimestamp(message.timestamp ?? record.timestamp);
    if (message.role === "assistant") {
      for (const value of Array.isArray(message.content) ? message.content : []) {
        const part = interactionObject(value);
        const callId = string(part?.id);
        const args = interactionObject(part?.arguments);
        if (part?.type === "toolCall" && callId && args)
          calls.set(callId, { args, timestamp: timestamp ?? calls.get(callId)?.timestamp });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const rawDetails = interactionObject(message.details);
    const details =
      message.toolName === "write" ? interactionObject(rawDetails?.message) : rawDetails;
    const callId = string(message.toolCallId) ?? entryKey;
    const call = calls.get(callId);
    if (details?.op === "send" && ["irc", "write"].includes(String(message.toolName))) {
      const from = string(details.from)
        ? context.resolveAgent(String(details.from))
        : source.agentId;
      const body =
        string(call?.args.message) ??
        (message.toolName === "write" ? string(call?.args.content) : undefined);
      if (body === undefined) continue;
      const receipts = Array.isArray(details.receipts) ? [...details.receipts] : [];
      const target = string(details.to);
      if (!receipts.length && message.isError === true && target && target !== "all")
        receipts.push({ to: target, outcome: "failed" });
      for (const value of receipts) {
        const receipt = interactionObject(value);
        const rawTo = string(receipt?.to);
        const outcome = receipt?.outcome;
        if (!rawTo || !["injected", "woken", "revived", "failed"].includes(String(outcome)))
          continue;
        const to = context.resolveAgent(rawTo);
        add(
          {
            eventId: `send:${source.agentId}:${callId}:${rawTo}`,
            kind: "message",
            fromAgentId: from,
            toAgentId: to,
            body,
            ...(call?.timestamp !== undefined ? { timestamp: call.timestamp } : {}),
            timeBasis: call?.timestamp === undefined ? "unknown" : "recorded",
            delivery: outcome as "injected" | "woken" | "revived" | "failed",
            source: source.source,
            ...(details.to === "all"
              ? { broadcastGroupId: `broadcast:${source.agentId}:${callId}` }
              : {}),
            ...(string(receipt?.error) ? { error: String(receipt?.error) } : {}),
          },
          "send",
          { startTimestamp: call?.timestamp, endTimestamp: timestamp },
        );
      }
    }
    const waited = interactionObject(details?.waited);
    if (
      details?.op === "wait" &&
      waited &&
      string(waited.id) &&
      string(waited.from) &&
      string(waited.to) &&
      typeof waited.body === "string"
    ) {
      const waitedTimestamp = interactionTimestamp(waited.ts);
      add(
        {
          eventId: `message:${waited.id}`,
          kind: "message",
          messageId: String(waited.id),
          fromAgentId: context.resolveAgent(String(waited.from)),
          toAgentId: context.resolveAgent(String(waited.to)),
          body: waited.body,
          ...(waitedTimestamp !== undefined ? { timestamp: waitedTimestamp } : {}),
          timeBasis: waitedTimestamp === undefined ? "unknown" : "sent",
          ...(string(waited.replyTo) ? { replyTo: String(waited.replyTo) } : {}),
          source: source.source,
          delivery: "observed",
        },
        "incoming",
      );
    }
    if (message.toolName === "task") {
      for (const value of [
        ...(Array.isArray(details?.progress) ? details.progress : []),
        ...(Array.isArray(details?.results) ? details.results : []),
      ]) {
        const progress = interactionObject(value);
        const rawId = string(progress?.id);
        const to = rawId ? context.knownChild(source.agentId, rawId) : undefined;
        if (!rawId || !to) continue;
        const body =
          string(progress?.assignment) ?? string(progress?.task) ?? string(progress?.description);
        if (body)
          add(
            {
              eventId: `task:${source.agentId}:${callId}:${rawId}:dispatch`,
              kind: "task_dispatch",
              fromAgentId: source.agentId,
              toAgentId: to,
              body,
              ...(call?.timestamp !== undefined ? { timestamp: call.timestamp } : {}),
              timeBasis: call?.timestamp === undefined ? "unknown" : "recorded",
              source: source.source,
            },
            "task",
          );
        const resultBody = string(progress?.resultText) ?? string(progress?.output);
        if (resultBody !== undefined)
          add(
            {
              eventId: `task:${source.agentId}:${callId}:${rawId}:result`,
              kind: "task_result",
              fromAgentId: to,
              toAgentId: source.agentId,
              body: resultBody,
              ...(timestamp !== undefined ? { timestamp } : {}),
              timeBasis: timestamp === undefined ? "unknown" : "recorded",
              source: source.source,
            },
            "task",
          );
      }
    }
    if (message.toolName === "wait") {
      for (const value of Array.isArray(details?.jobs) ? details.jobs : []) {
        const job = interactionObject(value);
        if (job?.type !== undefined && job.type !== "task") continue;
        const rawId = string(job?.agentUrlId) ?? string(job?.id);
        const from = rawId ? context.knownChild(source.agentId, rawId) : undefined;
        if (
          !rawId ||
          !from ||
          !["completed", "failed", "cancelled", "aborted"].includes(String(job?.status))
        )
          continue;
        const body = string(job?.resultText) ?? string(job?.errorText);
        if (!body) continue;
        // 同一 wait 条目的重复观察幂等；不同 wait 调用不能被正文相同误合并。
        add(
          {
            eventId: `result:${source.agentId}:${callId}:${rawId}`,
            kind: "task_result",
            fromAgentId: from,
            toAgentId: source.agentId,
            body,
            ...(timestamp !== undefined ? { timestamp } : {}),
            timeBasis: timestamp === undefined ? "unknown" : "recorded",
            source: source.source,
          },
          "task",
        );
      }
    }
  }
  return observations;
}

/** live 只保留与交互相关的原始结构，不复制普通对话、thinking 或用户输入。 */
export function interactionEntryFromEvent(value: unknown): unknown | null {
  const event = interactionObject(value);
  if (!event) return null;
  if (event.type === "irc_message" || event.type === "message_end") {
    const message = interactionObject(event.message);
    if (message?.role === "custom" && String(message.customType).startsWith("irc:"))
      return { type: "message", message };
    if (message?.role === "assistant") {
      const content = (Array.isArray(message.content) ? message.content : []).filter((value) => {
        const block = interactionObject(value);
        const args = interactionObject(block?.arguments);
        return (
          block?.type === "toolCall" &&
          (["irc", "task", "wait"].includes(String(block.name)) ||
            (block.name === "write" &&
              typeof args?.path === "string" &&
              args.path.startsWith("agent://")))
        );
      });
      return content.length
        ? { type: "message", message: { role: "assistant", timestamp: message.timestamp, content } }
        : null;
    }
    const details = interactionObject(message?.details);
    if (
      message?.role === "toolResult" &&
      (["irc", "task", "wait"].includes(String(message.toolName)) ||
        (message.toolName === "write" && interactionObject(details?.message)?.op === "send"))
    )
      return { type: "message", message };
  }
  if (!["irc", "task", "wait", "write"].includes(String(event.toolName))) return null;
  if (event.toolName === "write" && event.type === "tool_execution_start") {
    const args = interactionObject(event.args);
    if (typeof args?.path !== "string" || !args.path.startsWith("agent://")) return null;
  }
  if (event.type === "tool_execution_start")
    return {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args },
        ],
      },
    };
  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const result = interactionObject(
      event.type === "tool_execution_end" ? event.result : event.partialResult,
    );
    const details = interactionObject(result?.details);
    if (event.toolName === "write" && interactionObject(details?.message)?.op !== "send")
      return null;
    return result
      ? {
          type: "message",
          message: {
            role: "toolResult",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            ...result,
          },
        }
      : null;
  }
  return null;
}
