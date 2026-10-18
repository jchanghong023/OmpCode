// 纯协议解码、prompt_result 关联和事件投影；运行时终态/取消/队列见 adapterRuntime.e2e。

import assert from "node:assert/strict";
import test from "node:test";
import {
  ompPromptResultFrameSchema,
  ompSessionEventFrameSchema,
  ompStateDataSchema,
} from "../src/domain/ompFrames.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";

// ── A1：帧 schema ──

test("prompt_result schema：接受 status/sessionSettled/error 与未知扩展字段", () => {
  const parsed = ompPromptResultFrameSchema.safeParse({
    type: "prompt_result",
    id: "p-1",
    agentInvoked: true,
    status: "aborted",
    sessionSettled: true,
    error: { message: "abort won the race", retryable: false },
    futureField: { unknown: true },
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.status, "aborted");
  assert.equal(parsed.data.sessionSettled, true);
  assert.deepEqual(parsed.data.error, { message: "abort won the race", retryable: false });
  assert.deepEqual(parsed.data.futureField, { unknown: true });
  // 未知 status 字符串不拒帧（宽松处理，消费侧只认已知值）。
  assert.equal(
    ompPromptResultFrameSchema.parse({ type: "prompt_result", status: "future-status" }).status,
    "future-status",
  );
  // 旧核形态保留明确的本地命令完成信号，而不是依赖schema默认值。
  assert.equal(
    ompPromptResultFrameSchema.parse({ type: "prompt_result", agentInvoked: false }).agentInvoked,
    false,
  );
});

// ── A1：tracker ──

test("shouldFinish：登记 id 的 aborted/error 终态也要上抛（agentInvoked=true）", () => {
  const tracker = new PromptResultTracker();
  // 新核被取消 prompt：响应 success 无 data（agentInvoked 未知）→ 登记 id。
  tracker.noteResponse({ id: "cancelled", command: "prompt", success: true, data: undefined });
  // agentInvoked=true + status=aborted/error → 上抛（无模型回合的终态收尾）。
  assert.equal(
    tracker.shouldFinish({ id: "cancelled", agentInvoked: true, status: "aborted" }),
    true,
  );
  tracker.noteResponse({ id: "failed", command: "prompt", success: true, data: undefined });
  assert.equal(tracker.shouldFinish({ id: "failed", agentInvoked: true, status: "error" }), true);
  // completed（agentInvoked=true 的完成帧紧随 agent_end）不上抛。
  tracker.noteResponse({ id: "done", command: "prompt", success: true, data: undefined });
  assert.equal(
    tracker.shouldFinish({ id: "done", agentInvoked: true, status: "completed" }),
    false,
  );
  // 未登记 id 一律不上抛（id 关联语义保持）。
  assert.equal(
    tracker.shouldFinish({ id: "unrelated", agentInvoked: true, status: "aborted" }),
    false,
  );
});

test("get_state schema 保留模型、上下文及未知扩展，不把新字段变成空默认", () => {
  const state = ompStateDataSchema.parse({
    model: { provider: "future-core-provider", id: "bootstrap-model", futureModelField: true },
    thinkingLevel: "high",
    autoCompactionEnabled: false,
    contextUsage: { tokens: 1733, contextWindow: 65536, percent: 2.64, futureUsageField: 9 },
    queuedMessages: {
      steering: ["guide"],
      followUp: ["next"],
      liveSteered: 7,
      futureQueueField: true,
    },
    goal: { text: "扩展的目标信息", updatedAt: "2026-10-18T00:00:00.000Z" },
    futureStateField: { enabled: true },
  });
  assert.deepEqual(state.model, {
    provider: "future-core-provider",
    id: "bootstrap-model",
    futureModelField: true,
  });
  assert.equal(state.thinkingLevel, "high");
  assert.equal(state.autoCompactionEnabled, false);
  assert.deepEqual(state.contextUsage, {
    tokens: 1733,
    contextWindow: 65536,
    percent: 2.64,
    futureUsageField: 9,
  });
  assert.deepEqual(state.queuedMessages, {
    steering: ["guide"],
    followUp: ["next"],
    liveSteered: 7,
    futureQueueField: true,
  });
  assert.deepEqual(state.goal, { text: "扩展的目标信息", updatedAt: "2026-10-18T00:00:00.000Z" });
  assert.deepEqual(state.futureStateField, { enabled: true });
});

test("辅助会话事件不修改投影控制面、错误、用量与等待输入", () => {
  const projection = new ConversationProjection("auxiliary-events");
  const projector = new OmpEventProjector(projection);
  projection.beginUserTurn({
    text: "主轮",
    inputId: "running",
    sourceCommandId: "running",
    clientId: "client",
  });
  projector.handleEvent({ type: "agent_start" });
  projection.beginUserTurn({
    text: "等待输入",
    inputId: "queued",
    sourceCommandId: "queued",
    clientId: "client",
    routing: "queue",
  });
  const assertUnchanged = () => {
    const before = structuredClone(projection.buildSnapshot());
    for (const frame of [
      { type: "advisor_cost_changed" },
      { type: "session_settled" },
      { type: "goal_updated", goal: null },
      { type: "goal_updated", goal: { id: "goal-1", objective: "native goal", status: "active" } },
    ]) {
      projector.handleEvent(ompSessionEventFrameSchema.parse(frame));
      assert.deepEqual(projection.buildSnapshot(), before);
    }
  };
  assertUnchanged();
  projector.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "quota exceeded",
      usage: { input: 20, output: 5 },
    },
  });
  assert.deepEqual(projection.lastError, { code: "omp_provider_error", message: "quota exceeded" });
  assertUnchanged();
  projector.handleEvent({ type: "agent_end" });
  assert.equal(projection.stateSnapshot.control.phase, "error");
  assert.equal(projection.stateSnapshot.control.lastError?.message, "quota exceeded");
  assert.deepEqual(
    projection.stateSnapshot.queue.items.map((item) => item.sourceCommandId),
    ["queued"],
  );
  assertUnchanged();
});

test("未知类型与畸形消息被schema拒绝，已知扩展消息仍可解码并投影正文", () => {
  const invalidFrames = [
    { type: "unknown_core_event" },
    { type: "live_voice_state", voice: { state: "listening" } },
    { type: "message_end", message: null },
  ];
  for (const frame of invalidFrames) {
    const decoded = ompSessionEventFrameSchema.safeParse(frame);
    assert.equal(decoded.success, false, JSON.stringify(frame));
    if (decoded.success) throw new Error("invalid frame accepted");
    assert.ok(decoded.error.issues.length > 0);
  }
  const projection = new ConversationProjection("extended-message");
  const projector = new OmpEventProjector(projection);
  projection.beginUserTurn({ text: "t", inputId: "i", sourceCommandId: "c", clientId: "client" });
  const update = ompSessionEventFrameSchema.parse({
    type: "message_update",
    message: { role: "assistant", futureMessageField: { enabled: true } },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "扩展帧的正文",
      futureEventField: "retained",
    },
  });
  assert.equal(update.type, "message_update");
  if (update.type !== "message_update") throw new Error("wrong parsed event");
  assert.deepEqual(update.message.futureMessageField, { enabled: true });
  assert.equal(update.assistantMessageEvent.futureEventField, "retained");
  projector.handleEvent(update);
  projector.handleEvent(ompSessionEventFrameSchema.parse({ type: "agent_end", isTerminal: true }));
  assert.equal(projection.stateSnapshot.control.phase, "completedSuccess");
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "assistantText")
      .map((row) => row.text),
    ["扩展帧的正文"],
  );
});

// ── A2：auto_compaction_end 结果分支 ──

function compactMarkerStatuses(projection: ConversationProjection): string[] {
  return projection
    .rowsRange(undefined, 100)
    .rows.filter((row) => row.kind === "timelineMarker")
    .map((row) =>
      row.kind === "timelineMarker" && row.marker.type === "compact" ? row.marker.status : "",
    );
}

function projectorWithOpenTurn() {
  const projection = new ConversationProjection("compaction");
  const projector = new OmpEventProjector(projection);
  projection.beginUserTurn({ text: "t", inputId: "i", sourceCommandId: "c", clientId: "cl" });
  projector.handleEvent({ type: "auto_compaction_start" });
  return { projection, projector };
}

test("A2：aborted+willRetry → 标记重试中（running），不落 success", () => {
  const { projection, projector } = projectorWithOpenTurn();
  projector.handleEvent({ type: "auto_compaction_end", aborted: true, willRetry: true });
  assert.deepEqual(compactMarkerStatuses(projection).slice(-1), ["running"]);
});

test("A2：aborted 不重试或带 errorMessage → failed", () => {
  const first = projectorWithOpenTurn();
  first.projector.handleEvent({ type: "auto_compaction_end", aborted: true, willRetry: false });
  assert.deepEqual(compactMarkerStatuses(first.projection).slice(-1), ["failed"]);

  const second = projectorWithOpenTurn();
  second.projector.handleEvent({ type: "auto_compaction_end", errorMessage: "compaction failed" });
  assert.deepEqual(compactMarkerStatuses(second.projection).slice(-1), ["failed"]);
});

test("A2：无结果字段 → success；skipped → noop", () => {
  const success = projectorWithOpenTurn();
  // 旧核无载荷帧仍按成功收口。
  assert.equal(ompSessionEventFrameSchema.safeParse({ type: "auto_compaction_end" }).success, true);
  success.projector.handleEvent({ type: "auto_compaction_end" });
  assert.deepEqual(compactMarkerStatuses(success.projection).slice(-1), ["success"]);

  const skipped = projectorWithOpenTurn();
  skipped.projector.handleEvent({ type: "auto_compaction_end", skipped: true });
  assert.deepEqual(compactMarkerStatuses(skipped.projection).slice(-1), ["noop"]);
});
