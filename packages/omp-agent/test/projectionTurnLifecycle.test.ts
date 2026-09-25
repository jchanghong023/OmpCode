import assert from "node:assert/strict";
import test from "node:test";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { TurnFileFacts } from "../src/domain/fileFacts.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";

const input = (id: string, routing: "startNow" | "guide" | "queue" = "startNow") => ({
  text: id,
  inputId: id,
  sourceCommandId: id,
  clientId: "test",
  routing,
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
