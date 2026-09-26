// omp 会话文件条目 → v4 conversation rows 的冷恢复转换（防御式解析：omp 条目演化不应让恢复失败）。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { rowBaseFields } from "./projectionTypes.js";
import { ompTodoPlan } from "./ompTodoPlan.js";

interface ColdContext {
  sessionId: string;
  nextRowId: number;
  createdAtSeq: number;
  turnCounter: number;
}

interface ColdSubagent {
  id: string;
  agent: string;
  summary: string;
  status: "running" | "success" | "failed" | "cancelled";
  parentToolCallId: string;
  startedAt: number;
  endedAt?: number;
  resultText?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function coldSubagents(entries: readonly unknown[]): Map<string, ColdSubagent> {
  const agents = new Map<string, ColdSubagent>();
  for (const entry of entries) {
    const message = object(object(entry)?.message);
    if (message?.role !== "toolResult") continue;
    const details = object(message.details);
    if (message.toolName === "task" && typeof message.toolCallId === "string") {
      for (const raw of Array.isArray(details?.progress) ? details.progress : []) {
        const progress = object(raw);
        if (!progress || typeof progress.id !== "string" || !progress.id) continue;
        agents.set(progress.id, {
          id: progress.id,
          agent: typeof progress.agent === "string" ? progress.agent : "task",
          summary: (typeof progress.description === "string" ? progress.description :
            typeof progress.assignment === "string" ? progress.assignment :
            typeof progress.task === "string" ? progress.task : progress.id).replace(/\s+/g, " ").slice(0, 180),
          status: "running", parentToolCallId: message.toolCallId,
          startedAt: typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now(),
        });
      }
    }
    if (message.toolName === "wait") {
      for (const raw of Array.isArray(details?.jobs) ? details.jobs : []) {
        const job = object(raw);
        if (!job || typeof job.id !== "string") continue;
        const prior = agents.get(job.id);
        if (!prior) continue;
        prior.status = job.status === "completed" ? "success" : job.status === "failed" ? "failed" : job.status === "aborted" ? "cancelled" : "running";
        if (prior.status !== "running") prior.endedAt = typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now();
        if (typeof job.resultText === "string") prior.resultText = job.resultText;
      }
    }
  }
  return agents;
}

export function coldSubagentIds(entries: readonly unknown[]): string[] {
  return [...coldSubagents(entries).keys()];
}

export function transcriptFromOmpEntries(entries: readonly unknown[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const message = object(object(entry)?.message);
    if (!message || !["user", "assistant", "toolResult"].includes(String(message.role))) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = object(raw);
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        parts.push(`${message.role}: ${block.text}`);
      }
    }
  }
  return parts.join("\n\n").slice(0, 20_000);
}

export function rowsFromOmpEntries(entries: unknown[], subagentTranscripts: ReadonlyMap<string, string> = new Map()): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const agents = coldSubagents(entries);
  const context: ColdContext = { sessionId: "cold", nextRowId: 1, createdAtSeq: 1, turnCounter: 0 };
  let currentTurnId = "turn-cold-0";
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "message" && typeof record.message === "object" && record.message !== null) {
      const message = record.message as {
        role?: string;
        content?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
        timestamp?: number;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        details?: unknown;
      };
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      if (message.role === "user") {
        context.turnCounter += 1;
        currentTurnId = `turn-cold-${context.turnCounter}`;
        const text = (message.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        rows.push(makeRow(context, currentTurnId, "userInput", { kind: "userInput", text, origin: "realUser" }, timestamp));
        continue;
      }
      if (message.role === "assistant") {
        for (const block of message.content ?? []) {
          if (block.type === "thinking" && block.thinking) {
            rows.push(makeRow(context, currentTurnId, "reasoning", { kind: "reasoning", text: block.thinking, state: "complete" }, timestamp));
          } else if (block.type === "text" && block.text) {
            rows.push(makeRow(context, currentTurnId, "assistantText", { kind: "assistantText", text: block.text, state: "complete" }, timestamp));
          } else if (block.type === "toolCall" && typeof block.id === "string") {
            rows.push(
              makeRow(
                context,
                currentTurnId,
                `tool-${block.id}`,
                {
                  kind: "toolCall",
                  toolCallId: block.id,
                  toolName: typeof block.name === "string" ? block.name : "unknown",
                  status: "success",
                  inputText: safeStringify(block.arguments),
                  input: isJsonObject(block.arguments) ? block.arguments : undefined,
                },
                timestamp,
              ),
            );
          }
        }
        continue;
      }
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        const text = (message.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        const existing = rows.find(
          (row): row is Extract<ConversationRow, { kind: "toolCall" }> => row.kind === "toolCall" && row.toolCallId === message.toolCallId,
        );
        if (existing) {
          existing.status = message.isError === true ? "error" : "success";
          const plan = message.toolName === "todo" ? ompTodoPlan(message.details) : null;
          existing.output = { text, ...(plan ? { plan } : {}) };
          existing.endedAt = timestamp;
        }
        if (message.toolName === "task") {
          for (const agent of agents.values()) {
            if (agent.parentToolCallId !== message.toolCallId) continue;
            rows.push(makeRow(context, currentTurnId, `omp-subagent:${agent.id}`, {
              kind: "subagent", parentToolCallId: agent.parentToolCallId,
              subagentType: agent.agent, status: agent.status, summaryText: agent.summary,
              ...(subagentTranscripts.get(agent.id) || agent.resultText ? { transcriptText: subagentTranscripts.get(agent.id) || agent.resultText } : {}),
              startedAt: agent.startedAt, ...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
            }, timestamp));
          }
        }
        continue;
      }
    }
  }
  return rows;
}

function makeRow(
  context: ColdContext,
  turnId: string,
  entityId: string,
  fields: Record<string, unknown>,
  createdAt: number,
): ConversationRow {
  const rowId = context.nextRowId++;
  const productTurnId = turnId;
  const base = rowBaseFields({ rowId, turnId, entityId, productTurnId, createdAtSeq: context.createdAtSeq++ });
  // createdAt 使用条目时间戳（冷历史的时间线真实性优先于构造时刻）。
  return { ...base, createdAt, ...(fields as object) } as ConversationRow;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2).slice(0, 2048);
  } catch {
    return "";
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从条目中提取标题（title_change 优先，其后首条用户消息截断）。 */
export function titleFromOmpEntries(entries: unknown[]): string | null {
  let firstUserText: string | null = null;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "title_change" && typeof record.title === "string" && record.title.length > 0) {
      return record.title;
    }
    if (
      firstUserText === null &&
      record.type === "message" &&
      typeof record.message === "object" &&
      record.message !== null &&
      (record.message as { role?: string }).role === "user"
    ) {
      const content = (record.message as { content?: { type?: string; text?: string }[] }).content ?? [];
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ")
        .trim();
      if (text.length > 0) {
        firstUserText = text;
      }
    }
  }
  return firstUserText;
}
