import assert from "node:assert/strict";
import test from "node:test";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import {
  applyConversationDelta,
  applyConversationDeltas,
} from "../../shared/src/zcode-protocol-v4/apply.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { TurnFileFacts } from "../src/domain/fileFacts.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";

const input = (id: string, routing: "startNow" | "guide" | "queue" = "startNow") => ({
  text: id,
  inputId: id,
  sourceCommandId: id,
  clientId: "test",
  routing,
});

test("流式增量在运行中 snapshot、分页与完成态保持一致", () => {
  const projection = new ConversationProjection("stream-snapshot");
  projection.beginUserTurn(input("stream"));
  const expected = "chunk".repeat(200);
  for (let index = 0; index < 200; index += 1) {
    projection.appendAssistantText("chunk");
    if (index === 99) {
      const intermediate = projection
        .buildSnapshot()
        .rows.window.find((row) => row.kind === "assistantText");
      assert.equal(
        intermediate?.kind === "assistantText" && intermediate.text,
        "chunk".repeat(100),
      );
    }
  }
  const streaming = projection
    .buildSnapshot()
    .rows.window.find((row) => row.kind === "assistantText");
  assert.equal(streaming?.kind === "assistantText" && streaming.text, expected);
  const paged = projection
    .rowsRange(undefined, 100)
    .rows.find((row) => row.kind === "assistantText");
  assert.equal(paged?.kind === "assistantText" && paged.text, expected);
  projection.finishTurn("success");
  const completed = projection
    .rowsRange(undefined, 100)
    .rows.find((row) => row.kind === "assistantText");
  assert.equal(completed?.kind === "assistantText" && completed.text, expected);
});

test("批量应用同帧 deltas 与逐条应用一致且不修改已发布快照", () => {
  const projection = new ConversationProjection("batch-apply");
  projection.beginUserTurn(input("batch"));
  projection.drainPendingDeltas();
  const previous = projection.buildSnapshot();
  const unchanged = structuredClone(previous);
  projection.appendAssistantText("hello");
  projection.appendAssistantText(" world");
  const deltas = projection.drainPendingDeltas();
  const expected = deltas.reduce(applyConversationDelta, previous);
  assert.deepEqual(applyConversationDeltas(previous, deltas), expected);
  assert.deepEqual(previous, unchanged);
});

test("批量应用移除后追加行仍保持索引和状态 patch 语义", () => {
  const projection = new ConversationProjection("batch-rewind");
  projection.beginUserTurn(input("rewind"));
  const previous = projection.buildSnapshot();
  const userRow = previous.rows.window.find((row) => row.kind === "userInput");
  assert.ok(userRow);
  const deltas: ConversationDelta[] = [
    { op: "row.removed", fromRowId: userRow.rowId },
    { op: "row.appended", row: { ...userRow, rowId: userRow.rowId + 10 } },
    { op: "state.updated", patch: { revision: previous.revision + 1 } },
  ];
  assert.deepEqual(
    applyConversationDeltas(previous, deltas),
    deltas.reduce(applyConversationDelta, previous),
  );
});

test("guide 收口旧轮和新轮的流式行及文件事实", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.appendAssistantText("old text");
  projection.upsertToolCall({
    toolCallId: "write-1",
    toolName: "write",
    status: "success",
    input: { path: "old.txt", content: "a\n" },
  });
  projection.beginUserTurn(input("guide", "guide"));
  projection.appendAssistantText("guided text");
  projection.finishTurn("success");
  const rows = projection.rowsRange(undefined, 100).rows;
  assert.deepEqual(
    rows.filter((row) => row.kind === "turnHeader").map((row) => row.state),
    ["completedSuccess", "completedSuccess"],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.state),
    ["complete", "complete"],
  );
  const first = rows.find((row) => row.kind === "turnHeader");
  assert.equal(first?.kind === "turnHeader" && first.fileChanges.files, 1);
});

test("queue 保留当前轮输出，下一次 agent_start 才激活后续轮", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.appendAssistantText("before");
  projection.beginUserTurn(input("queued", "queue"));
  projection.appendAssistantText("after");
  projection.finishTurn("success");
  projection.activateQueuedTurn();
  projection.appendAssistantText("next");
  projection.finishTurn("success");
  const rows = projection.rowsRange(undefined, 100).rows;
  const texts = rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    texts.map((row) => row.text),
    ["beforeafter", "next"],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "turnHeader").map((row) => row.state),
    ["completedSuccess", "completedSuccess"],
  );
});

test("hashline edit 使用成功结果 diff 记录路径与实际增删", () => {
  const facts = new TurnFileFacts();
  facts.recordToolResult({
    toolName: "edit",
    input: { input: "[src/example.ts#1A2B]\nPUT 4.=4:\n+const value = 2;" },
    resultDetails: {
      diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -4 +4 @@\n-old\n+const value = 2;",
    },
  });
  assert.deepEqual(facts.summary(), { files: 1, additions: 1, deletions: 1 });
  assert.equal(facts.items()[0]?.path, "src/example.ts");
});

test("只有关联 request id 的本地 prompt_result 可以异步收口", () => {
  const tracker = new PromptResultTracker();
  tracker.noteResponse({ id: "local", command: "prompt", success: true, data: {} });
  tracker.noteResponse({
    id: "agent",
    command: "prompt",
    success: true,
    data: { agentInvoked: true },
  });
  assert.equal(tracker.shouldFinish({ id: "agent", agentInvoked: true }), false);
  assert.equal(tracker.shouldFinish({ id: "unrelated", agentInvoked: false }), false);
  assert.equal(tracker.shouldFinish({ id: "local", agentInvoked: false }), true);
  assert.equal(tracker.shouldFinish({ id: "local", agentInvoked: false }), false);
});

test("turn 进行中到达的 startNow 入队等待，不覆盖活跃轮", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.appendAssistantText("before");
  // 冷启动窗口双投递：ensureOmpStarted 未返回时第二条命令同样按非流式算成 startNow。
  projection.beginUserTurn(input("second", "startNow"));
  // 旧轮保持激活：后续流式文本仍归属旧轮。
  projection.appendAssistantText("after");
  projection.finishTurn("success");
  projection.activateQueuedTurn();
  projection.appendAssistantText("next");
  projection.finishTurn("success");
  const rows = projection.rowsRange(undefined, 100).rows;
  const texts = rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    texts.map((row) => row.text),
    ["beforeafter", "next"],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "turnHeader").map((row) => row.state),
    ["completedSuccess", "completedSuccess"],
  );
});
