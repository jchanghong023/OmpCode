import assert from "node:assert/strict";
import test from "node:test";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type { OmpCommandOutputRecord } from "../src/domain/OmpCommandOutput.js";
import type {
  HostGateway,
  OmpProcessFactory,
  OmpSessionProcess,
  OmpSessionProcessHandlers,
} from "../src/app/ports.js";

function harness(holdInput = false) {
  let handlers!: OmpSessionProcessHandlers;
  const outputs: OmpCommandOutputRecord[] = [];
  const sent: string[] = [];
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async dispose() {},
    respondUi() {},
    async refreshState() {
      return null;
    },
    async readContextReport() {
      return null;
    },
    async send(command) {
      sent.push(command.type);
      return {
        success: true,
        data: command.type === "prompt" ? { agentInvoked: !command.message.startsWith("/") } : {},
      };
    },
  };
  const factory: OmpProcessFactory = {
    create(options) {
      handlers = options;
      return process;
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () =>
      holdInput ? new Promise<never>(() => {}) : { action: "cancel" as const },
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "native",
    workspaceId: "workspace",
    workspacePath: ".",
    gateway,
    ompFactory: factory,
    onIndexChange() {},
    resolveSlashCommand: async () => ({ kind: "dispatch" }),
    onCommandOutput: async (record) => {
      outputs.push(record);
    },
  });
  return { engine, outputs, sent, handlers: () => handlers };
}

test("本地 ACK 后的多段输出独立落行，不丢失或伪装成模型轮", async () => {
  const { engine, handlers, outputs } = harness();
  try {
    await engine.sendText("/wiki", "wiki", "client");
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
    assert.equal(
      engine.projection.rowsRange(undefined, 100).rows.find((row) => row.kind === "turnHeader")
        ?.executionKind,
      "controlOnly",
    );
    handlers().onCommandOutput?.({ text: "索引状态\n第一段" });
    handlers().onCommandOutput?.({ text: "检索结果\n第二段" });
    assert.deepEqual(
      engine.projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "assistantText")
        .map((row) => row.text),
      ["索引状态\n第一段", "检索结果\n第二段"],
    );
    assert.equal(new Set(outputs.map((record) => record.id)).size, 2);
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedSuccess");
  } finally {
    await engine.dispose();
  }
});

for (const action of ["answer", "stop"] as const) {
  test(`背景 ACK 后等待交互开启 canStop，${action} 移除等待后恢复既有控制`, async () => {
    const { engine, handlers } = harness(true);
    try {
      await engine.sendText("/wiki", "wiki", "client");
      const baseline = engine.projection.stateSnapshot.control;
      assert.equal(baseline.canStop, false);
      handlers().onUiRequest({
        frame: { id: "wiki-select", method: "select", title: "Indexes", options: ["Index"] },
        respond() {},
      });
      assert.equal(engine.projection.stateSnapshot.control.phase, baseline.phase);
      assert.equal(engine.projection.stateSnapshot.control.canStop, true);
      assert.equal(engine.projection.stateSnapshot.control.stopState, "stoppable");
      // ACK 的控制 patch 不能盖过仍在场的真实等待。
      engine.projection.patchSideViewState({ control: baseline });
      assert.equal(engine.projection.stateSnapshot.control.canStop, true);
      if (action === "stop") {
        await engine.stop();
        assert.equal(engine.projection.stateSnapshot.control.canStop, false);
        assert.equal(engine.projection.stateSnapshot.control.stopState, "stopping");
      }
      const waiting = engine.projection.stateSnapshot.pendingInteractions[0]!;
      engine.settleInteraction(
        waiting.interactionId,
        action === "answer" ? { action: "accept", optionId: "Index" } : { action: "cancel" },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(engine.projection.stateSnapshot.pendingInteractions.length, 0);
      assert.deepEqual(engine.projection.stateSnapshot.control, baseline);
    } finally {
      await engine.dispose();
    }
  });
}

test("等待解除和本地 ACK 不回退并行模型的 running/stopping 控制", async () => {
  const { engine, handlers } = harness(true);
  const ask = (id: string) =>
    handlers().onUiRequest({
      frame: { id, method: "select", title: "Indexes", options: ["Index"] },
      respond() {},
    });
  try {
    await engine.sendText("model task", "model", "client");
    handlers().onEvent({ type: "agent_start" });
    const running = engine.projection.stateSnapshot.control;
    ask("running-select");
    await engine.sendText("/advisor status", "advisor", "client");
    let waiting = engine.projection.stateSnapshot.pendingInteractions[0]!;
    engine.settleInteraction(waiting.interactionId, { action: "accept", optionId: "Index" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(engine.projection.stateSnapshot.control, running);
    ask("stopping-select");
    await engine.stop();
    waiting = engine.projection.stateSnapshot.pendingInteractions[0]!;
    engine.settleInteraction(waiting.interactionId, { action: "cancel" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.projection.stateSnapshot.control.phase, "running");
    assert.equal(engine.projection.stateSnapshot.control.canStop, false);
    assert.equal(engine.projection.stateSnapshot.control.stopState, "stopping");
    handlers().onEvent({ type: "agent_end", isTerminal: true, messages: [] });
    assert.equal(engine.projection.stateSnapshot.control.phase, "completedInterrupted");
    assert.equal(engine.projection.stateSnapshot.control.canStop, false);
  } finally {
    await engine.dispose();
  }
});

test("busy 本地提交只收口自身，输出不拼入正在流式的助手文本或消费普通队首", async () => {
  const { engine, handlers } = harness();
  try {
    await engine.sendText("first", "first", "client");
    handlers().onEvent({ type: "agent_start" });
    engine.projection.appendAssistantText("before");
    await engine.sendText("queued", "queued", "client");
    const delivery = await engine.sendText("/advisor status", "advisor", "client");
    assert.equal(delivery, "startNow");
    handlers().onCommandOutput?.({ text: "Advisor disabled." });
    engine.projection.appendAssistantText("after");
    const rows = engine.projection.rowsRange(undefined, 100).rows;
    assert.deepEqual(
      rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
      ["beforeafter", "Advisor disabled."],
    );
    const headers = rows.filter((row) => row.kind === "turnHeader");
    assert.deepEqual(
      headers.map((row) => [row.sourceCommandId, row.state]),
      [
        ["first", "running"],
        ["queued", "running"],
        ["advisor", "completedSuccess"],
      ],
    );
    assert.equal(engine.projection.stateSnapshot.control.phase, "running");
    assert.equal(engine.projection.hasQueuedTurns(), true);
  } finally {
    await engine.dispose();
  }
});

test("旧进程在关闭后迟到的 command_output 不落行或保存", async () => {
  const { engine, handlers, outputs } = harness();
  await engine.ensureOmpStarted();
  const previous = handlers();
  await engine.dispose();
  previous.onCommandOutput?.({ text: "stale" });
  assert.deepEqual(outputs, []);
  assert.deepEqual(engine.projection.rowsRange(undefined, 100).rows, []);
});

test("原生 loop/goal 自动轮完整显示，不重复 accepted 输入也不再发 prompt", async () => {
  const { engine, handlers, sent } = harness();
  const reply = (text: string) => {
    handlers().onEvent({ type: "message_start", message: { role: "assistant", content: [] } });
    handlers().onEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    handlers().onEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    handlers().onEvent({ type: "agent_end", messages: [], isTerminal: true });
  };
  try {
    await engine.sendText("loop task", "first", "client");
    handlers().onEvent({ type: "agent_start" });
    handlers().onEvent({ type: "message_start", message: { role: "user", content: "loop task" } });
    reply("iteration one");
    handlers().onEvent({ type: "agent_start" });
    for (let i = 0; i < 2; i++)
      handlers().onEvent({
        type: "message_start",
        message: { role: "user", content: "loop task" },
      });
    reply("iteration two");
    handlers().onEvent({ type: "agent_start" });
    reply("goal continuation without user frame");
    const rows = engine.projection.rowsRange(undefined, 100).rows;
    assert.deepEqual(
      rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
      ["iteration one", "iteration two", "goal continuation without user frame"],
    );
    assert.deepEqual(
      rows.filter((row) => row.kind === "userInput").map((row) => [row.text, row.origin]),
      [
        ["loop task", "realUser"],
        ["loop task", "synthetic"],
      ],
    );
    assert.equal(rows.filter((row) => row.kind === "turnHeader").length, 3);
    assert.ok(
      rows
        .filter((row) => row.kind === "turnHeader")
        .every((row) => row.state === "completedSuccess"),
    );
    assert.equal(sent.filter((type) => type === "prompt").length, 1);
  } finally {
    await engine.dispose();
  }
});

test("原生压缩 ACK 后输出刷新真实上下文总量和分项", { timeout: 3000 }, async () => {
  let handlers!: OmpSessionProcessHandlers;
  let usedTokens = 512;
  let resolveRefresh!: () => void;
  const refreshed = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async dispose() {},
    respondUi() {},
    async send() {
      return { success: true, data: { agentInvoked: false } };
    },
    async refreshState() {
      if (usedTokens === 120) resolveRefresh();
      return {
        contextUsage: { tokens: usedTokens, contextWindow: 200_000, percent: usedTokens / 2000 },
      };
    },
    async readContextReport() {
      return { contextWindow: 200_000, entries: [{ label: "Messages", tokens: usedTokens }] };
    },
  };
  const engine = new ConversationEngine({
    sessionId: "compact",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: {
      create(options) {
        handlers = options;
        return process;
      },
    },
    gateway: {
      emitFrame() {},
      requestUserInput: async () => ({ action: "cancel" as const }),
    } as HostGateway,
    onIndexChange() {},
  });
  try {
    await engine.sendText("/compact soft", "compact", "client");
    assert.equal(engine.projection.stateSnapshot.usage.contextWindow?.usedTokens, 512);
    usedTokens = 120;
    handlers.onCommandOutput?.({ text: "Compaction complete." });
    await refreshed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.projection.stateSnapshot.usage.contextWindow?.usedTokens, 120);
    assert.deepEqual(engine.projection.stateSnapshot.usage.contextWindow?.details?.entries, [
      { label: "Messages", tokens: 120 },
    ]);
    assert.equal(
      engine.projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "timelineMarker").length,
      0,
    );
  } finally {
    await engine.dispose();
  }
});
