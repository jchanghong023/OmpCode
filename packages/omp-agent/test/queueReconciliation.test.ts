// 纯输入/轮次投影；真实派发、取消与恢复由 realOmpHarness 消费者验收。
import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";
import type { TurnSubmission } from "../src/domain/projectionRows.js";

function begin(
  projection: ConversationProjection,
  id: string,
  text: string,
  routing: "startNow" | "queue" | "guide" = "queue",
  overrides: Partial<TurnSubmission> = {},
) {
  const submission: TurnSubmission = {
    text,
    originalText: text,
    images: [],
    sourceCommandId: id,
    clientId: "client",
    generation: 1,
    delivery: routing === "guide" ? "steer" : "prompt",
    state: routing === "queue" ? "pending" : "dispatching",
    ...overrides,
  };
  projection.beginUserTurn({
    text,
    inputId: id,
    sourceCommandId: id,
    clientId: "client",
    routing,
    submission,
  });
  return submission;
}

function activeProjection() {
  const projection = new ConversationProjection("queue-consumer");
  begin(projection, "active", "A", "startNow");
  userStart(new OmpEventProjector(projection), "A");
  return projection;
}

function userStart(projector: OmpEventProjector, text: string) {
  projector.handleEvent({ type: "message_start", message: { role: "user", content: text } });
}

function headerState(projection: ConversationProjection, commandId: string) {
  const header = projection
    .rowsRange(undefined, 100)
    .rows.find((row) => row.kind === "turnHeader" && row.sourceCommandId === commandId);
  assert.ok(header?.kind === "turnHeader", `missing turn ${commandId}`);
  return header.state;
}

function queuedIds(projection: ConversationProjection) {
  return conversationSnapshotSchema
    .parse(projection.buildSnapshot())
    .queue.items.map((item) => item.sourceCommandId);
}

test("同文三项保持独立身份和顺序，真实用户消费一次并保留各自输出", () => {
  const projection = activeProjection();
  const projector = new OmpEventProjector(projection);
  for (let index = 0; index < 3; index++) begin(projection, `hello-${index}`, "hello");
  const waiting = conversationSnapshotSchema.parse(projection.buildSnapshot());
  assert.deepEqual(queuedIds(projection), ["hello-0", "hello-1", "hello-2"]);
  assert.equal(new Set(waiting.queue.items.map((item) => item.queueItemId)).size, 3);
  assert.equal(projection.claimQueuedSubmission(1), null, "上轮未成功结束不能派发");
  projector.handleEvent({ type: "agent_end" });
  projection.drainPendingDeltas();
  for (let index = 0; index < 3; index++) {
    const expected = Array.from({ length: 3 - index }, (_, offset) => `hello-${index + offset}`);
    const submission = projection.claimQueuedSubmission(1);
    assert.equal(submission?.sourceCommandId, `hello-${index}`);
    assert.deepEqual(queuedIds(projection), expected, "派发租约不能冒充真实消费");
    assert.equal(projection.claimQueuedSubmission(1), null, "不得重复派发同一输入");
    projector.handleEvent({ type: "agent_start" });
    assert.deepEqual(queuedIds(projection), expected, "agent_start不是消费事实");
    userStart(projector, "hello");
    userStart(projector, "hello");
    assert.deepEqual(queuedIds(projection), expected.slice(1), "重复回显不能吞下一项");
    projection.appendAssistantText(`reply-${index}`);
    const input = projection
      .rowsRange(undefined, 100)
      .rows.find((row) => row.kind === "userInput" && row.sourceCommandId === `hello-${index}`);
    assert.ok(input);
    assert.deepEqual(
      projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "assistantText" && row.turnId === input.turnId)
        .map((row) => (row.kind === "assistantText" ? row.text : "")),
      [`reply-${index}`],
    );
    projector.handleEvent({ type: "agent_end" });
  }
  assert.deepEqual(queuedIds(projection), []);
  assert.ok(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .every((row) => row.state === "completedSuccess"),
  );
  projection.drainPendingDeltas();
  assert.ok(
    projection
      .deltasBetween(waiting.seq, projection.seq)
      ?.some((delta) => delta.op === "state.updated" && delta.patch.queue?.items.length === 0),
  );
});

test("首发同文回显不能消费尚未派发的第二和第三条输入", () => {
  const projection = new ConversationProjection("same-text-echo");
  const projector = new OmpEventProjector(projection);
  begin(projection, "first", "hello", "startNow");
  begin(projection, "second", "hello");
  begin(projection, "third", "hello");
  userStart(projector, "hello");
  userStart(projector, "hello");
  assert.deepEqual(queuedIds(projection), ["second", "third"]);
  assert.equal(projection.activeTurnSourceCommandId(), "first");
  assert.equal(headerState(projection, "first"), "running");
});

test("逐项派发保留图片、模型、原文和命令归属，不凭空消费纯图片", () => {
  const projection = activeProjection();
  const projector = new OmpEventProjector(projection);
  const payloads = ["", "rewritten"].map((text, index) => ({
    text,
    originalText: `/original-${index}`,
    images: [{ type: "image" as const, data: `image-${index}`, mimeType: "image/png" }],
    modelSelection: { provider: "local", model: `model-${index}`, thought: "high" },
    sourceCommandId: `payload-${index}`,
    clientId: `client-${index}`,
    generation: 1,
    delivery: "prompt" as const,
    state: "pending" as const,
  }));
  for (const payload of payloads)
    begin(projection, payload.sourceCommandId, payload.text, "queue", payload);
  projector.handleEvent({ type: "agent_end" });
  for (const payload of payloads) {
    const claimed = projection.claimQueuedSubmission(1);
    assert.ok(claimed);
    assert.deepEqual({ ...claimed, state: "pending" }, payload);
    projector.handleEvent({ type: "agent_start" });
    assert.ok(queuedIds(projection).includes(payload.sourceCommandId));
    userStart(projector, payload.text);
    assert.equal(projection.activeTurnSourceCommandId(), payload.sourceCommandId);
    projector.handleEvent({ type: "agent_end" });
  }
  assert.deepEqual(queuedIds(projection), []);
});

test("按commandId失败收口只删除目标，不误删同文本等待项", () => {
  const projection = activeProjection();
  begin(projection, "accepted", "hello");
  begin(projection, "failed", "hello");
  projection.failCommandTurn("failed", { code: "omp_prompt_failed", message: "rejected" });
  assert.deepEqual(queuedIds(projection), ["accepted"]);
  assert.deepEqual(
    projection.stateSnapshot.queue.items.map((item) => item.sourceCommandId),
    ["accepted"],
  );
  assert.equal(headerState(projection, "failed"), "failed");
  assert.equal(headerState(projection, "active"), "running");
});

for (const outcome of ["interrupted", "failed"] as const) {
  test(`${outcome}撤销已claim和未派发项，旧代次不能派发或污染新轮`, () => {
    const projection = activeProjection();
    begin(projection, "old-claimed", "old");
    begin(projection, "old-pending", "old");
    projection.finishTurn("success");
    assert.equal(projection.claimQueuedSubmission(2), null, "新进程不能领取旧代次");
    const claimed = projection.claimQueuedSubmission(1);
    assert.ok(claimed);
    const error = { code: "provider", message: "original provider failure" };
    projection.cancelQueuedSubmissions(outcome, outcome === "failed" ? error : undefined);
    assert.deepEqual(queuedIds(projection), []);
    assert.equal(claimed.state, "cancelled", "旧异步续体失去派发租约");
    assert.equal(projection.claimQueuedSubmission(1), null);
    assert.equal(projection.claimQueuedSubmission(2), null);
    assert.equal(
      headerState(projection, "old-claimed"),
      outcome === "failed" ? "failed" : "completedInterrupted",
    );
    assert.equal(
      headerState(projection, "old-pending"),
      outcome === "failed" ? "failed" : "completedInterrupted",
    );
    assert.deepEqual(projection.lastError, outcome === "failed" ? error : null);
    begin(projection, "new-run", "new", "startNow", { generation: 2 });
    userStart(new OmpEventProjector(projection), "old");
    assert.equal(projection.activeTurnSourceCommandId(), "new-run");
    assert.equal(projection.lastError, null);
  });
}

test("guide只由真实steer用户消息消费，成功终态不能将其改为prompt重发", () => {
  const projection = activeProjection();
  const projector = new OmpEventProjector(projection);
  projection.appendAssistantText("A reply");
  begin(projection, "guide", "G", "guide");
  assert.deepEqual(queuedIds(projection), ["guide"]);
  projector.handleEvent({ type: "agent_end" });
  assert.equal(projection.claimQueuedSubmission(1), null);
  assert.deepEqual(queuedIds(projection), ["guide"]);
  userStart(
    projector,
    "<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\nG",
  );
  assert.deepEqual(queuedIds(projection), []);
  assert.equal(projection.activeTurnSourceCommandId(), "guide");
  projection.appendAssistantText("G reply");
  projector.handleEvent({ type: "agent_end" });
  assert.equal(headerState(projection, "active"), "completedSuccess");
  assert.equal(headerState(projection, "guide"), "completedSuccess");
  assert.equal(projection.claimQueuedSubmission(1), null);
});

test("guide失败保留原错误，等待项取消后不能作为prompt重发", () => {
  const projection = activeProjection();
  const guide = begin(projection, "guide", "G", "guide");
  const originalError = { code: "provider", message: "original guide failure" };
  projection.recordTurnError(originalError);
  projection.finishTurn("failed", originalError);
  projection.cancelQueuedSubmissions("failed", { code: "later", message: "late acknowledgement" });
  assert.equal(guide.state, "cancelled");
  assert.deepEqual(queuedIds(projection), []);
  assert.deepEqual(projection.lastError, originalError);
  assert.equal(headerState(projection, "guide"), "failed");
  assert.equal(projection.claimQueuedSubmission(1), null);
});
