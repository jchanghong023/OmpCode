// 投影行构造器：turnHeader / userInput / 流式行 / 工具行 / marker 的纯构造与合并。
// 从 conversationProjection 拆出（架构 maxFileLines=400）；只做行对象组装，不碰状态机。

import type { ConversationRow, TimelineMarkerPayload, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { rowBaseFields } from "./projectionTypes.js";
import type { TurnFileFacts } from "./fileFacts.js";

export interface TurnContext {
  turnId: string;
  sourceCommandId: string;
  productTurnId: string;
  headerRowId: number;
  fileFacts: TurnFileFacts;
  responseCounter: number;
  streamingTextRow: { rowId: number; entityId: string } | null;
  streamingReasoningRow: { rowId: number; entityId: string } | null;
}

export function conversationRowsRange(
  rowIds: readonly number[],
  rowAt: (id: number) => ConversationRow | undefined,
  beforeRowId: number | undefined,
  limit: number,
): { rows: ConversationRow[]; hasMore: boolean } {
  const ids = beforeRowId === undefined ? rowIds : rowIds.filter((id) => id < beforeRowId);
  const page = ids.slice(-limit);
  const first = page[0];
  return { rows: page.map((id) => rowAt(id)!), hasMore: first !== undefined && ids.indexOf(first) > 0 };
}

export interface RowInit {
  rowId: number;
  turnId: string;
  productTurnId: string;
  createdAtSeq: number;
}

export interface ToolCallUpsert {
  toolCallId: string;
  toolName: string;
  status: ToolCallRow["status"];
  inputText?: string;
  input?: unknown;
  outputText?: string;
  error?: { code: string; message: string };
  startedAt?: number;
  endedAt?: number;
  resultDetails?: unknown;
}

export function createTurnHeaderRow(init: RowInit & { sourceCommandId: string; historyRoundCount: number }): ConversationRow {
  return {
    ...rowBaseFields({ ...init, entityId: init.turnId }),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    sourceCommandId: init.sourceCommandId,
    historyRoundCount: init.historyRoundCount,
    state: "running",
    startedAt: Date.now(),
    fileChanges: { additions: 0, deletions: 0, files: 0 },
  };
}

export function createUserInputRow(init: RowInit & { text: string; sourceCommandId: string; clientId: string }): ConversationRow {
  return {
    ...rowBaseFields({ ...init, entityId: `input-${init.sourceCommandId}-${init.rowId}` }),
    kind: "userInput",
    text: init.text,
    origin: "realUser",
    sourceCommandId: init.sourceCommandId,
    clientId: init.clientId,
  };
}

export function createStreamingRow(
  init: RowInit & { kind: "assistantText" | "reasoning"; responseCounter: number },
): ConversationRow {
  const entityId = `resp-${init.turnId}-${init.responseCounter}-${init.kind === "assistantText" ? "text" : "reasoning"}`;
  return {
    ...rowBaseFields({ ...init, entityId }),
    kind: init.kind,
    assistantResponseId: entityId,
    text: "",
    state: "streaming",
  };
}

export function createToolCallRow(init: RowInit & ToolCallUpsert): ToolCallRow {
  return {
    ...rowBaseFields({ ...init, entityId: `tool-${init.toolCallId}` }),
    kind: "toolCall",
    toolCallId: init.toolCallId,
    toolName: init.toolName,
    status: init.status,
    inputText: init.inputText ?? "",
    ...(init.input !== undefined ? { input: init.input } : {}),
    ...(init.outputText !== undefined ? { output: { text: init.outputText } } : {}),
    ...(init.error !== undefined ? { error: init.error } : {}),
    ...(init.startedAt !== undefined ? { startedAt: init.startedAt } : {}),
    ...(init.endedAt !== undefined ? { endedAt: init.endedAt } : {}),
  };
}

export function mergeToolCallRow(existing: ToolCallRow, update: ToolCallUpsert): ToolCallRow {
  return {
    ...existing,
    status: update.status,
    ...(update.inputText !== undefined ? { inputText: update.inputText } : {}),
    ...(update.input !== undefined ? { input: update.input } : {}),
    ...(update.outputText !== undefined ? { output: { text: update.outputText } } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
  };
}

export function createMarkerRow(init: RowInit & { marker: TimelineMarkerPayload }): ConversationRow {
  return {
    ...rowBaseFields({ ...init, entityId: `marker-${init.rowId}` }),
    kind: "timelineMarker",
    marker: init.marker,
  };
}

/** 快照读面：从投影的内部视图组装 ConversationSnapshot（B 区取尾部窗口）。 */
export interface ProjectionView {
  sessionId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  state: import("./projectionTypes.js").ProjectionAState;
  rowIds: number[];
  rowAt(rowId: number): ConversationRow | undefined;
}

export function buildConversationSnapshot(view: ProjectionView, tailWindowRows: number): import("@zcode/shared/zcode-protocol-v4").ConversationSnapshot {
  const window = view.rowIds.slice(-tailWindowRows).map((id) => view.rowAt(id)!);
  return {
    protocolVersion: 1,
    sessionId: view.sessionId,
    logEpoch: view.logEpoch,
    seq: view.seq,
    revision: view.revision,
    control: view.state.control,
    availability: view.state.availability,
    inputRouting: view.state.inputRouting,
    meta: view.state.meta,
    config: view.state.config,
    modelTransition: view.state.modelTransition,
    usage: view.state.usage,
    queue: view.state.queue,
    pendingInteractions: view.state.pendingInteractions,
    pendingCommands: view.state.pendingCommands,
    backgroundWorks: view.state.backgroundWorks,
    subagents: view.state.subagents,
    goal: view.state.goal,
    plan: view.state.plan,
    workspaceHookAdmission: view.state.workspaceHookAdmission,
    rows: {
      window,
      totalCount: view.rowIds.length,
      firstRowId: view.rowIds.length > 0 ? view.rowIds[0]! : null,
    },
  };
}
