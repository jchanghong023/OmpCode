// A1/A2/A9 修复 UT：prompt_result 终态语义（status/sessionSettled/error）、
// auto_compaction_end 结果分支投影、引擎事件入口对畸形帧的防御。

import assert from "node:assert/strict";
import test from "node:test";
import {
  ompPromptResultFrameSchema,
  ompSessionEventFrameSchema,
  type OmpPromptResultFrame,
  type OmpSessionEventFrame,
  type OmpStateData,
} from "../src/domain/ompFrames.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type { HostGateway, OmpProcessFactory, OmpSessionProcess } from "../src/app/ports.js";

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
  // 未知 status 字符串不拒帧（宽松处理，消费侧只认已知值）。
  assert.equal(
    ompPromptResultFrameSchema.safeParse({ type: "prompt_result", status: "future-status" })
      .success,
    true,
  );
  // 旧核形态（仅 type/agentInvoked）仍可解析。
  assert.equal(
    ompPromptResultFrameSchema.safeParse({ type: "prompt_result", agentInvoked: false }).success,
    true,
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

// ── A1：引擎四种顺序 ──

interface CapturedHandlers {
  onEvent: (event: OmpSessionEventFrame) => void;
  onPromptResult: (frame: OmpPromptResultFrame) => void;
}

function createEngine() {
  const handlers = {} as CapturedHandlers;
  const process: OmpSessionProcess = {
    ompSessionFile: "test.jsonl",
    async start() {},
    async send() {
      return { success: true };
    },
    respondUi() {},
    async refreshState(): Promise<OmpStateData> {
      return {};
    },
    async readContextReport() {
      return null;
    },
    async dispose() {},
  };
  const factory: OmpProcessFactory = {
    create(options) {
      handlers.onEvent = options.onEvent;
      handlers.onPromptResult = options.onPromptResult!;
      return process;
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "prompt-result",
    workspaceId: "w",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  return { engine, handlers };
}

test("A1 顺序①：aborted 无 agent 事件 → 当前轮收口 interrupted", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("被取消的输入", "cmd-1", "client");
    assert.equal(engine.projection.stateSnapshot.control.phase, "running");
    handlers.onPromptResult({ type: "prompt_result", agentInvoked: true, status: "aborted" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedInterrupted");
  } finally {
    await engine.dispose();
  }
});

test("A1 顺序②：aborted 在 terminal agent_end 之后 → no-op 不覆盖成功终态", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("正常输入", "cmd-1", "client");
    handlers.onEvent({ type: "agent_start" });
    handlers.onEvent({ type: "agent_end" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
    handlers.onPromptResult({ type: "prompt_result", agentInvoked: true, status: "aborted" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
  } finally {
    await engine.dispose();
  }
});

test("A1 顺序③：error 无 agent 事件 → 当前轮收口 failed 并携带错误文本", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("失败输入", "cmd-1", "client");
    handlers.onPromptResult({
      type: "prompt_result",
      agentInvoked: true,
      status: "error",
      error: { message: "quota exceeded", retryable: false },
    });
    const control = engine.projection.stateSnapshot.control;
    assert.equal(control.phase, "error");
    assert.equal(control.lastError?.message, "quota exceeded");
  } finally {
    await engine.dispose();
  }
});

test("A1 顺序④：completed 在 terminal agent_end 之后 → no-op", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("正常输入", "cmd-1", "client");
    handlers.onEvent({ type: "agent_start" });
    handlers.onEvent({ type: "agent_end" });
    handlers.onPromptResult({ type: "prompt_result", agentInvoked: true, status: "completed" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
  } finally {
    await engine.dispose();
  }
});

// ── S4-3：agentInvoked=false 的失败/取消终态路由 ──
// 依据：omp rpc-prompt-results.ts fail() 语义是「prompt 在到达 agent 前失败」
// （status:"error" 且 agentInvoked=false）；需求 A1「取消/失败的 prompt 按
// interrupted/failed 收口」。仅 completed/无 status 的 agentInvoked=false 才是本地命令完成。

test("S4-3：agentInvoked=false + status=error → failed 收口并透传错误", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("失败输入", "cmd-1", "client");
    handlers.onPromptResult({
      type: "prompt_result",
      agentInvoked: false,
      status: "error",
      error: { message: "prompt rejected before agent" },
    });
    const control = engine.projection.stateSnapshot.control;
    assert.equal(control.phase, "error");
    assert.equal(control.lastError?.message, "prompt rejected before agent");
  } finally {
    await engine.dispose();
  }
});

test("S4-3：agentInvoked=false + status=aborted → interrupted；completed 仍走本地命令成功", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("被取消输入", "cmd-1", "client");
    handlers.onPromptResult({ type: "prompt_result", agentInvoked: false, status: "aborted" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedInterrupted");

    const local = createEngine();
    try {
      await local.engine.sendText("本地命令", "cmd-2", "client");
      local.handlers.onPromptResult({
        type: "prompt_result",
        agentInvoked: false,
        status: "completed",
      });
      assert.equal(local.engine.projection.stateSnapshot.control.phase, "completedSuccess");
    } finally {
      await local.engine.dispose();
    }
  } finally {
    await engine.dispose();
  }
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

// ── A9：引擎事件入口防御 ──

test("A9：畸形会话事件帧只跳过该帧，不断事件流", async () => {
  const { engine, handlers } = createEngine();
  try {
    await engine.sendText("t", "cmd-1", "client");
    // 项目通道对会话事件帧是裸 cast：message 为 null 的 message_end 会在投影层抛
    // TypeError；入口必须吞掉单帧异常（warn + 跳过），后续帧照常处理。
    engine.handleOmpEvent({
      type: "message_end",
      message: null,
    } as unknown as OmpSessionEventFrame);
    assert.equal(engine.projection.stateSnapshot.control.phase, "running");
    handlers.onEvent({ type: "agent_start" });
    handlers.onEvent({ type: "agent_end" });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
    // 只读详情视图入口（subagentViews 内联投影，同一防御语义）同样跳过畸形帧。
    try {
      engine.projector.handleEvent({
        type: "message_end",
        message: null,
      } as unknown as OmpSessionEventFrame);
      assert.fail("畸形帧应在投影层抛错");
    } catch {
      // 预期：调用方（视图）吞掉单帧异常。
    }
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
  } finally {
    await engine.dispose();
  }
});
