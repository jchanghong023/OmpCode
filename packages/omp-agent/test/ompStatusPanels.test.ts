import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";

const phases = [
  {
    name: "测试",
    tasks: [
      { content: "已完成", status: "completed" },
      { content: "当前项", status: "in_progress" },
      { content: "下一项", status: "pending" },
    ],
  },
];

function begin(projection: ConversationProjection) {
  projection.beginUserTurn({
    text: "test",
    inputId: "test",
    sourceCommandId: "test",
    clientId: "test",
  });
}

test("todo 结果同时更新独立面板、Desktop 增量与 Web 快照，失败保留清单、空结果清除", () => {
  const projection = new ConversationProjection("parent");
  begin(projection);
  const projector = new OmpEventProjector(projection);
  const result = (id: string, details: unknown, isError = false) => {
    projector.handleEvent({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "todo",
      args: {},
    });
    projector.handleEvent({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "todo",
      isError,
      result: { content: [{ type: "text", text: "todo result" }], details },
    });
  };
  result("todo-1", { phases });
  const snapshot = conversationSnapshotSchema.parse(projection.buildSnapshot());
  assert.deepEqual(
    snapshot.plan?.items.map((item) => [item.content, item.status]),
    [
      ["已完成", "completed"],
      ["当前项", "inProgress"],
      ["下一项", "pending"],
    ],
  );
  const patches = projection.drainPendingDeltas().filter((delta) => delta.op === "state.updated");
  assert.deepEqual(patches.at(-1)?.patch.plan, snapshot.plan);
  result("todo-failed", { phases: [] }, true);
  assert.deepEqual(projection.buildSnapshot().plan, snapshot.plan);
  result("todo-malformed", { phases: "invalid" });
  assert.deepEqual(projection.buildSnapshot().plan, snapshot.plan);
  result("todo-clear", { phases: [] });
  assert.equal(projection.buildSnapshot().plan, null);
});

test("冷恢复从最后有效 todo 重建面板，不把后续失败当成清空", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "todo", timestamp: 1000 } },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1001,
        content: [
          { type: "toolCall", id: "todo-1", name: "todo", arguments: {} },
          { type: "toolCall", id: "todo-2", name: "todo", arguments: {} },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "todo-1",
        toolName: "todo",
        content: "ok",
        timestamp: 1002,
        details: { phases },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "todo-2",
        toolName: "todo",
        content: "failed",
        timestamp: 1003,
        isError: true,
        details: { phases: [] },
      },
    },
  ];
  const projection = new ConversationProjection("cold-parent");
  projection.hydrateRows(rowsFromOmpEntries(entries, new Map()));
  assert.equal(projection.buildSnapshot().plan?.items.length, 3);
  assert.equal(projection.buildSnapshot().plan?.updatedAt, 1002);
  projection.replaceHydratedRows([]);
  assert.equal(projection.buildSnapshot().plan, null);
});

test("并发子代理的主对话行与独立目录使用同一详情地址，结束与冷恢复不串内容", () => {
  const projection = new ConversationProjection("parent");
  begin(projection);
  for (const id of ["a", "b"])
    projection.upsertSubagent({ id, agent: "scout", status: "running", summaryText: `任务 ${id}` });
  let snapshot = conversationSnapshotSchema.parse(projection.buildSnapshot());
  assert.equal(snapshot.subagents.running.length, 2);
  assert.deepEqual(
    snapshot.subagents.running.map((item) => item.childSessionId),
    ["omp-subagent:a@parent", "omp-subagent:b@parent"],
  );
  for (const id of ["a", "b"])
    projection.upsertSubagent({ id, agent: "scout", status: "success", summaryText: `任务 ${id}` });
  snapshot = projection.buildSnapshot();
  assert.equal(snapshot.subagents.running.length, 0);
  assert.equal(snapshot.subagents.endedTotal, 2);
  const rows = snapshot.rows.window.filter((row) => row.kind === "subagent");
  assert.deepEqual(
    rows.map((row) => row.childSessionId),
    projection.subagentDirectory().ended.items.map((item) => item.childSessionId),
  );
  const restored = new ConversationProjection("parent");
  restored.hydrateRows(
    snapshot.rows.window.map((row) =>
      row.kind === "subagent" ? { ...row, childSessionId: undefined } : row,
    ),
  );
  assert.equal(restored.buildSnapshot().subagents.endedTotal, 2);
  assert.deepEqual(
    restored
      .buildSnapshot()
      .rows.window.filter((row) => row.kind === "subagent")
      .map((row) => row.childSessionId),
    rows.map((row) => row.childSessionId),
  );
});

test("跨轮完成的后台子代理保留启动轮和明确的父工具关联", () => {
  const projection = new ConversationProjection("parent");
  begin(projection);
  projection.upsertSubagent({
    id: "a",
    agent: "task",
    status: "running",
    summaryText: "后台任务",
    parentToolCallId: "task-a",
  });
  const original = projection.buildSnapshot().rows.window.find((row) => row.kind === "subagent");
  projection.finishTurn("success");
  projection.beginUserTurn({
    text: "next",
    inputId: "next",
    sourceCommandId: "next",
    clientId: "test",
  });
  projection.upsertSubagent({ id: "a", agent: "task", status: "success", summaryText: "后台任务" });
  const ended = projection.buildSnapshot().rows.window.find((row) => row.kind === "subagent");
  assert.equal(ended?.turnId, original?.turnId);
  assert.equal(ended?.kind === "subagent" && ended.parentToolCallId, "task-a");
  assert.ok(original);
  const restored = new ConversationProjection("parent");
  restored.hydrateRows([original]);
  restored.upsertSubagent({ id: "a", agent: "task", status: "success", summaryText: "后台任务" });
  assert.equal(
    restored.buildSnapshot().rows.window.find((row) => row.kind === "subagent")?.status,
    "success",
  );
});
