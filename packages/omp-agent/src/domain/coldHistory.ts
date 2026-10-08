// omp 会话文件条目 → v4 conversation rows 的冷恢复转换（防御式解析：omp 条目演化不应让恢复失败）。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { rowBaseFields } from "./projectionTypes.js";
import { ompTodoPlan } from "./ompTodoPlan.js";
import { visibleOmpCustomMessage } from "./OmpCustomMessage.js";

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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
          summary: (typeof progress.description === "string"
            ? progress.description
            : typeof progress.assignment === "string"
              ? progress.assignment
              : typeof progress.task === "string"
                ? progress.task
                : progress.id
          )
            .replace(/\s+/g, " ")
            .slice(0, 180),
          status: "running",
          parentToolCallId: message.toolCallId,
          startedAt:
            typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now(),
        });
      }
    }
    if (message.toolName === "wait") {
      for (const raw of Array.isArray(details?.jobs) ? details.jobs : []) {
        const job = object(raw);
        if (!job || typeof job.id !== "string") continue;
        const prior = agents.get(job.id);
        if (!prior) continue;
        prior.status =
          job.status === "completed"
            ? "success"
            : job.status === "failed"
              ? "failed"
              : job.status === "aborted"
                ? "cancelled"
                : "running";
        if (prior.status !== "running")
          prior.endedAt =
            typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now();
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
    const record = object(entry);
    const message = object(record?.message);
    const custom = visibleOmpCustomMessage(record?.type === "custom_message" ? record : message);
    if (custom) {
      parts.push(`custom: ${custom.text}`);
      continue;
    }
    if (!message || !["user", "assistant", "toolResult"].includes(String(message.role))) continue;
    if (typeof message.content === "string") {
      if (message.content) parts.push(`${message.role}: ${message.content}`);
      continue;
    }
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

/**
 * S7-3 预扫描：文件内全部 assistant toolCall id 与已落盘 toolResult id（完成事实）。
 * 配对只承认「结果已写盘」；进程崩溃时文件里只有 toolCall 没有 toolResult。
 */
function collectToolCallPairing(entries: readonly unknown[]): {
  calledIds: Set<string>;
  resultIds: Set<string>;
} {
  const calledIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const entry of entries) {
    const record = object(entry);
    if (record?.type !== "message") continue;
    const message = object(record.message);
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = object(raw);
        if (block?.type === "toolCall" && typeof block.id === "string") calledIds.add(block.id);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      resultIds.add(message.toolCallId);
    }
  }
  return { calledIds, resultIds };
}

/**
 * S7-3 消费 omp 崩溃退出诊断（exit-diagnostics.ts 语义）：最后一条 session_exit custom
 * 条目的 data.pendingToolCalls。agent-session.ts teardown 时以 collectPendingToolCalls
 * 全分支回放写入，且只在非空时落盘（正常收尾无该字段）。
 */
function collectExitPendingToolCallIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const record = object(entries[index]);
    if (record?.type !== "custom" || record.customType !== "session_exit") continue;
    const data = object(record.data);
    const pending = Array.isArray(data?.pendingToolCalls) ? data.pendingToolCalls : [];
    for (const raw of pending) {
      const item = object(raw);
      if (item && typeof item.toolCallId === "string") ids.add(item.toolCallId);
    }
    return ids;
  }
  return ids;
}

export function rowsFromOmpEntries(
  entries: unknown[],
  subagentTranscripts: ReadonlyMap<string, string> = new Map(),
): ConversationRow[] {
  // 修复（S7-3，§8.2/§15.2(5)）：中断集合 = omp 显式退出诊断（session_exit.pendingToolCalls
  // 可消费则优先并入）∪ 配对扫描出的无完成事实调用。已落盘 toolResult 的完成事实恒胜出
  // （成功/失败按 isError）；无完成事实一律收尾为中断终态 cancelled——原先硬编码 success
  // 会把崩溃时从未执行完的命令冷恢复成绿色成功。选 cancelled 对齐 fork 既有约定
  // （ompProjectChannel C2：interrupted/aborted 无完成事实 → cancelled）与 omp 恢复语义
  // （createInterruptedTurnAbortMessage 的「上一进程在完成前退出」= stopReason aborted）。
  const { calledIds, resultIds } = collectToolCallPairing(entries);
  const interruptedIds = collectExitPendingToolCallIds(entries);
  for (const id of calledIds) {
    if (!resultIds.has(id)) interruptedIds.add(id);
  }
  const rows: ConversationRow[] = [];
  // toolResult 配对从 O(n²) rows.find 改为 Map（行为等价）。
  const toolRows = new Map<string, Extract<ConversationRow, { kind: "toolCall" }>>();
  const agents = coldSubagents(entries);
  const context: ColdContext = { sessionId: "cold", nextRowId: 1, createdAtSeq: 1, turnCounter: 0 };
  let currentTurnId = "turn-cold-0";
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const custom = visibleOmpCustomMessage(
      record.type === "custom_message" ? record : record.message,
    );
    if (custom) {
      // omp 的 team 后台调度通知只写 journal、从不经 rpc-ui live 通道下发（live 时间线与
      // 派生存储均无该行）；冷恢复照 journal 显示会破坏 live/冷一致。阶段进度已有
      // command_output 输出、子代理明细已有 Agent Hub，此处不重复进时间线。
      if (record.type === "custom_message" && record.customType === "team-dispatch") {
        continue;
      }
      // 原生 custom 是独立显示事实；挂最近模型 turn 会让多个 team 结果被 UI 组的
      // latest-assistant 规则互相隐藏。用 journal entry ID 稳定分组，不推进模型轮。
      const displayId =
        typeof record.id === "string" && record.id
          ? `omp-native-custom:${record.id}`
          : `omp-native-custom-row:${context.nextRowId}`;
      rows.push(
        makeRow(
          context,
          displayId,
          displayId,
          { kind: "assistantText", text: custom.text, state: "complete" },
          custom.timestamp ?? Date.now(),
        ),
      );
      // /skill: 轮 journal 只有 skill-prompt（attribution=user）而无用户消息；不推进轮
      // 计数会把后续回复并入上一用户轮，被组内 latest-assistant 规则隐藏（GUI 冷恢复
      // 实测丢失正文 ultrathink 的模型回复）。用户侧可见 custom 即一轮的输入边界。
      const attribution =
        record.type === "custom_message" ? record.attribution : object(record.message)?.attribution;
      if (attribution === "user") {
        context.turnCounter += 1;
        currentTurnId = `turn-cold-${context.turnCounter}`;
      }
      continue;
    }
    if (
      record.type === "message" &&
      typeof record.message === "object" &&
      record.message !== null
    ) {
      const message = record.message as {
        role?: string;
        content?:
          | string
          | {
              type?: string;
              text?: string;
              thinking?: string;
              id?: string;
              name?: string;
              arguments?: unknown;
            }[];
        timestamp?: number;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        details?: unknown;
      };
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      // omp 的合法 UserMessage.content 可以是字符串；不能用数组操作使整个冷恢复失败。
      const content: Exclude<
        NonNullable<typeof message.content>,
        string
      > = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content.filter((block) => block && typeof block === "object")
          : [];
      if (message.role === "user") {
        context.turnCounter += 1;
        currentTurnId = `turn-cold-${context.turnCounter}`;
        const text = content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        rows.push(
          makeRow(
            context,
            currentTurnId,
            "userInput",
            { kind: "userInput", text, origin: "realUser" },
            timestamp,
          ),
        );
        continue;
      }
      if (message.role === "assistant") {
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            rows.push(
              makeRow(
                context,
                currentTurnId,
                "reasoning",
                { kind: "reasoning", text: block.thinking, state: "complete" },
                timestamp,
              ),
            );
          } else if (block.type === "text" && block.text) {
            rows.push(
              makeRow(
                context,
                currentTurnId,
                "assistantText",
                { kind: "assistantText", text: block.text, state: "complete" },
                timestamp,
              ),
            );
          } else if (block.type === "toolCall" && typeof block.id === "string") {
            const toolRow = makeRow(
              context,
              currentTurnId,
              `tool-${block.id}`,
              {
                kind: "toolCall",
                toolCallId: block.id,
                toolName: typeof block.name === "string" ? block.name : "unknown",
                status: interruptedIds.has(block.id) ? "cancelled" : "success",
                inputText: safeStringify(block.arguments),
                input: isJsonObject(block.arguments) ? block.arguments : undefined,
              },
              timestamp,
            ) as Extract<ConversationRow, { kind: "toolCall" }>;
            rows.push(toolRow);
            toolRows.set(block.id, toolRow);
          }
        }
        continue;
      }
      if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        const text = content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        const existing = toolRows.get(message.toolCallId);
        if (existing) {
          existing.status = message.isError === true ? "error" : "success";
          const plan = message.toolName === "todo" ? ompTodoPlan(message.details) : null;
          existing.output = { text, ...(plan ? { plan } : {}) };
          existing.endedAt = timestamp;
        }
        if (message.toolName === "task") {
          for (const agent of agents.values()) {
            if (agent.parentToolCallId !== message.toolCallId) continue;
            rows.push(
              makeRow(
                context,
                currentTurnId,
                `omp-subagent:${agent.id}`,
                {
                  kind: "subagent",
                  parentToolCallId: agent.parentToolCallId,
                  subagentType: agent.agent,
                  status: agent.status,
                  summaryText: agent.summary,
                  ...(subagentTranscripts.get(agent.id) || agent.resultText
                    ? { transcriptText: subagentTranscripts.get(agent.id) || agent.resultText }
                    : {}),
                  startedAt: agent.startedAt,
                  ...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
                },
                timestamp,
              ),
            );
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
  const base = rowBaseFields({
    rowId,
    turnId,
    entityId,
    productTurnId,
    createdAtSeq: context.createdAtSeq++,
  });
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

export { titleFromOmpEntries } from "./coldSessionTitle.js";
