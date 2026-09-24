// omp 会话文件条目 → v4 conversation rows 的冷恢复转换（防御式解析：omp 条目演化不应让恢复失败）。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { rowBaseFields } from "./projectionTypes.js";

interface ColdContext {
  sessionId: string;
  nextRowId: number;
  createdAtSeq: number;
  turnCounter: number;
}

export function rowsFromOmpEntries(entries: unknown[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
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
          existing.output = { text };
          existing.endedAt = timestamp;
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
