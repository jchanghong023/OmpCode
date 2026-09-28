// P2 验收 D1 回归：中断后工具行终态。
// 证据：Windows/CentOS 双平台真实 omp v18.3.5+fork.265 实测同一事件序列——
// abort 时 omp 依次发 tool_execution_end(isError:true) → 尾随 tool_execution_update
// （partialResult="[Command cancelled]"）→ terminal agent_end。旧投影把尾随 update
// 当运行态更新，把已终态工具行复活为 running，且 failOpenToolRows 因在途表已清无法
// 再收口，造成「会话标头已 Stopped 但工具行残留 Running」。
import assert from "node:assert/strict";
import test from "node:test";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";

function beginTurn(projection: ConversationProjection, text: string): void {
  projection.beginUserTurn({ text, inputId: "in-1", sourceCommandId: "cmd-1", clientId: "test" });
}

function rowsOf(projection: ConversationProjection) {
  return projection.rowsRange(undefined, 200).rows;
}

function toolRowOf(projection: ConversationProjection) {
  const row = rowsOf(projection).find((row) => row.kind === "toolCall");
  return row?.kind === "toolCall" ? row : null;
}

function headerOf(projection: ConversationProjection) {
  const row = rowsOf(projection).find((row) => row.kind === "turnHeader");
  return row?.kind === "turnHeader" ? row : null;
}

test("中断收口：end(isError) 后的尾随 tool_execution_update 不得复活工具行，终态为 cancelled", () => {
  const projection = new ConversationProjection("d1-interrupted");
  const projector = new OmpEventProjector(projection);
  beginTurn(projection, "请执行命令 sleep 90");
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "sleep 90" },
  });
  assert.equal(toolRowOf(projection)?.status, "running");

  // 用户点击停止 → omp abort 事件序列（与真实 omp 实测逐帧一致）
  projector.noteStopRequested();
  projector.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "Command aborted" }] },
    isError: true,
  });
  // 尾随更新：修复前此处把终态行改回 running（D1 根因）
  projector.handleEvent({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "sleep 90" },
    partialResult: { content: [{ type: "text", text: "[Command cancelled]\n" }] },
  });
  projector.handleEvent({ type: "agent_end", messages: [], isTerminal: true });

  const toolRow = toolRowOf(projection);
  assert.ok(toolRow, "缺少工具行");
  assert.equal(toolRow.status, "cancelled");
  assert.ok(toolRow.output?.text === "Command aborted", "中断取消防保留原始输出");
  assert.equal(toolRow.error, undefined, "用户中断不是工具失败，不应携带 error");
  assert.equal(headerOf(projection)?.state, "completedInterrupted");
});

test("非中断的 isError 工具终态仍是 error，且结束后的尾随 update 不改变终态", () => {
  const projection = new ConversationProjection("d1-genuine-error");
  const projector = new OmpEventProjector(projection);
  beginTurn(projection, "run failing tool");
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "bash",
    args: {},
  });
  projector.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call-2",
    toolName: "bash",
    result: { content: [{ type: "text", text: "exit 1" }] },
    isError: true,
  });
  projector.handleEvent({
    type: "tool_execution_update",
    toolCallId: "call-2",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "late tail" }] },
  });
  projector.handleEvent({ type: "agent_end", messages: [], isTerminal: true });

  const toolRow = toolRowOf(projection);
  assert.equal(toolRow?.status, "error");
  assert.equal(toolRow?.error?.code, "tool_error");
  assert.equal(toolRow?.output?.text, "exit 1", "尾随 update 不得改写终态行内容");
  // 既有语义：工具行失败不等于轮失败（轮失败仅由 provider/运行时错误决定）。
  assert.equal(headerOf(projection)?.state, "completedSuccess");
});

test("无 end 事件的在途工具由 terminal agent_end 收口为 cancelled，此后尾随 update 不复活", () => {
  const projection = new ConversationProjection("d1-fail-open");
  const projector = new OmpEventProjector(projection);
  beginTurn(projection, "long task");
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call-3",
    toolName: "write",
    args: {},
  });
  projector.noteStopRequested();
  projector.handleEvent({ type: "agent_end", messages: [], isTerminal: true });
  assert.equal(toolRowOf(projection)?.status, "cancelled");

  // agent_end 之后的迟到更新：轮已收口（turn=null）或 endedTools 兜底，均不得复活
  projector.handleEvent({
    type: "tool_execution_update",
    toolCallId: "call-3",
    toolName: "write",
    partialResult: { content: [{ type: "text", text: "late" }] },
  });
  assert.equal(toolRowOf(projection)?.status, "cancelled");
});

test("工具正常完成后同一轮内的后续工具不受 endedTools 影响", () => {
  const projection = new ConversationProjection("d1-sequential");
  const projector = new OmpEventProjector(projection);
  beginTurn(projection, "two tools");
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call-a",
    toolName: "bash",
    args: {},
  });
  projector.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call-a",
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call-b",
    toolName: "write",
    args: {},
  });
  projector.handleEvent({
    type: "tool_execution_update",
    toolCallId: "call-b",
    toolName: "write",
    partialResult: { content: [{ type: "text", text: "streaming output" }] },
  });
  projector.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call-b",
    toolName: "write",
    result: { content: [{ type: "text", text: "written" }] },
    isError: false,
  });
  projector.handleEvent({ type: "agent_end", messages: [], isTerminal: true });

  const rows = rowsOf(projection).filter((row) => row.kind === "toolCall");
  assert.deepEqual(
    rows.map((row) => (row.kind === "toolCall" ? row.status : "")),
    ["success", "success"],
  );
});
