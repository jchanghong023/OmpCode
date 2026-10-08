// A3/A4/A5 修复 UT：omp 队列对账（queue_update/get_state）、agent_start 合并收口排队轮、
// steer 在途与 terminal agent_end 竞态时 guide 轮转回排队。
// XR1 加固 UT：对账 get_state 陈旧快照竞态守卫（输入接受序号）。
// 依据（omp v18.6 源码核对）：新 prompt 的 run 在停止边界把 followUp 队列合并进同一 run
// （agent-loop.ts 停止边界 dequeue；agent-session.ts 用户 prompt 解除中断冻结），
// 旧核（v18.4.8）abort 后队列冻结、get_state.queuedMessages 仍是队列事实。
// S4-1/S4-2/S4-3/S4-4 修复 UT：停止边界 drain 消费的 seen（在场历史）判定、从未 seen 轮的
// 宽限复查、"/" 前缀 chip 匹配（用例见下方 A3/S4 区块）。
// F2b 修复 UT：follow_up/steer 分发 success ACK ⇒ 已入队（v18.4.8：rpc handler 在 await
// followUp()/steer() 后才回 ACK）→ ACK 到达即以 markOnly 登记 seen（快速 drain 无需任何
// 快照，P1）；"/" 前缀匹配收紧为命令名段比对（/deploy 不命中 /deploy-prod，P2）。
// 语义变更（P1）：success ACK 已到达的排队轮不再属于「从未 seen」宽限场景——宽限/
// interrupted 用例的「从未 seen」前提改由 ACK 在途未达构造（runWithQueuedFollowUpPendingAck）。

import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type {
  HostGateway,
  OmpCommandOutcome,
  OmpProcessFactory,
  OmpSessionProcess,
} from "../src/app/ports.js";
import type { OmpSessionEventFrame, OmpStateData } from "../src/domain/ompFrames.js";

interface EngineHarness {
  engine: ConversationEngine;
  onEvent: (event: OmpSessionEventFrame) => void;
  rows(): ConversationRow[];
}

function createEngine(
  options: {
    /** 返回 Promise 时模拟在途 get_state（由测试择机 resolve 陈旧/新鲜快照）。 */
    state?: () => OmpStateData | Promise<OmpStateData>;
    sendOutcome?: (command: { type: string }) => Promise<OmpCommandOutcome>;
  } = {},
): EngineHarness {
  let onEvent: ((event: OmpSessionEventFrame) => void) | undefined;
  const process: OmpSessionProcess = {
    ompSessionFile: "queue.jsonl",
    async start() {},
    async send(command) {
      return options.sendOutcome ? options.sendOutcome(command) : { success: true };
    },
    respondUi() {},
    async refreshState(): Promise<OmpStateData> {
      return options.state ? options.state() : {};
    },
    async readContextReport() {
      return null;
    },
    async dispose() {},
  };
  const factory: OmpProcessFactory = {
    create(handlers) {
      onEvent = handlers.onEvent;
      return process;
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "queue",
    workspaceId: "w",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  return {
    engine,
    onEvent: (event) => onEvent?.(event),
    rows: () => engine.projection.rowsRange(undefined, 100).rows,
  };
}

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("连续三条相同输入发布独立队列，核心消费后输出逐条归属且终态清空", async () => {
  const harness = createEngine();
  try {
    await harness.engine.sendText("A", "a", "client");
    harness.onEvent({ type: "agent_start" });
    for (let i = 0; i < 3; i++) await harness.engine.sendText("hello", `hello-${i}`, "client");
    const waiting = conversationSnapshotSchema.parse(harness.engine.projection.buildSnapshot());
    assert.deepEqual(
      waiting.queue.items.map((item) => item.sourceCommandId),
      ["hello-0", "hello-1", "hello-2"],
    );
    assert.equal(new Set(waiting.queue.items.map((item) => item.queueItemId)).size, 3);
    harness.engine.projection.drainPendingDeltas();
    for (let i = 0; i < 3; i++) {
      harness.onEvent({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      });
      assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 2 - i);
      harness.onEvent({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      });
      assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 2 - i);
      streamText(harness, `reply-${i}`);
      const input = harness
        .rows()
        .find((row) => row.kind === "userInput" && row.sourceCommandId === `hello-${i}`)!;
      assert.deepEqual(assistantTextsOf(harness, input.turnId), [`reply-${i}`]);
    }
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.ok(headerStates(harness).every((header) => header.state === "completedSuccess"));
    assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 0);
    harness.engine.projection.drainPendingDeltas();
    const replay = harness.engine.projection.deltasBetween(
      waiting.seq,
      harness.engine.projection.seq,
    );
    assert.ok(
      replay?.some(
        (delta) => delta.op === "state.updated" && delta.patch.queue?.items.length === 0,
      ),
      "Web 重放与 Desktop 连续帧共享清空队列事实",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("队列分发失败移除对应等待项，不误删另一条相同输入", async () => {
  let rejectNext = false;
  const harness = createEngine({
    sendOutcome: async (command) =>
      command.type === "follow_up" && rejectNext
        ? { success: false, error: "rejected" }
        : { success: true },
  });
  try {
    await harness.engine.sendText("A", "a", "client");
    harness.onEvent({ type: "agent_start" });
    await harness.engine.sendText("hello", "accepted", "client");
    rejectNext = true;
    await harness.engine.sendText("hello", "failed", "client");
    harness.engine.projection.drainPendingDeltas();
    assert.deepEqual(
      harness.engine.projection.buildSnapshot().queue.items.map((item) => item.sourceCommandId),
      ["accepted"],
    );
    const failed = harness
      .rows()
      .find((row) => row.kind === "turnHeader" && row.sourceCommandId === "failed");
    assert.equal(failed?.kind === "turnHeader" ? failed.state : null, "failed");
  } finally {
    await harness.engine.dispose();
  }
});

test("首条 hello 的迟到回显不消费另外两条相同文本", async () => {
  const harness = createEngine();
  try {
    await harness.engine.sendText("hello", "first", "client");
    harness.onEvent({ type: "agent_start" });
    await harness.engine.sendText("hello", "second", "client");
    await harness.engine.sendText("hello", "third", "client");
    harness.onEvent({ type: "message_start", message: { role: "user", content: "hello" } });
    assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 2);
    harness.onEvent({ type: "message_start", message: { role: "user", content: "hello" } });
    assert.deepEqual(
      harness.engine.projection.buildSnapshot().queue.items.map((item) => item.sourceCommandId),
      ["third"],
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("首发接受到 agent_start 之间的输入仍走 follow_up", async () => {
  const commands: string[] = [];
  const harness = createEngine({
    sendOutcome: async (command) => {
      commands.push(command.type);
      return { success: true };
    },
  });
  try {
    await harness.engine.sendText("hello", "first", "client");
    assert.equal(await harness.engine.sendText("hello", "second", "client"), "queue");
    assert.equal(await harness.engine.sendText("hello", "third", "client"), "queue");
    assert.deepEqual(
      commands.filter((type) => ["prompt", "follow_up"].includes(type)),
      ["prompt", "follow_up", "follow_up"],
    );
    harness.onEvent({ type: "agent_start" });
    assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 2);
    harness.onEvent({ type: "message_start", message: { role: "user", content: "hello" } });
    assert.equal(harness.engine.projection.buildSnapshot().queue.items.length, 2);
  } finally {
    await harness.engine.dispose();
  }
});

function headerStates(harness: EngineHarness): { turnId: string; state: unknown }[] {
  return harness
    .rows()
    .filter((row) => row.kind === "turnHeader")
    .map((row) => ({ turnId: row.turnId, state: row.state }));
}

function assistantTextsOf(harness: EngineHarness, turnId: string): string[] {
  return harness
    .rows()
    .filter((row) => row.kind === "assistantText" && row.turnId === turnId)
    .map((row) => (row.kind === "assistantText" ? row.text : ""));
}

function streamText(harness: EngineHarness, delta: string): void {
  harness.onEvent({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta },
  });
}

/** A 流式运行 + B follow_up 排队的公共前奏；返回 B 的 turnId。 */
async function runWithQueuedFollowUp(harness: EngineHarness): Promise<string> {
  await harness.engine.sendText("A", "cmd-a", "client");
  harness.onEvent({ type: "agent_start" });
  const delivery = await harness.engine.sendText("B 文本", "cmd-b", "client");
  assert.equal(delivery, "queue");
  assert.equal(harness.engine.projection.hasQueuedTurns(), true);
  return harness.rows().find((row) => row.kind === "userInput" && row.text === "B 文本")!.turnId;
}

/**
 * A 流式运行 + B follow_up 排队（success ACK 在途未达）的公共前奏；返回引擎与 B 的 turnId。
 * F2b-P1 之后的「从未 seen」前提构造：success ACK 到达即按分发原文自匹配登记 seen
 * （ACK ⇒ 已入队，v18.4.8），故宽限/interrupted 场景必须让 ACK 在途未达（send 挂起不落）——
 * 轮已本地排队，但入队事实尚未被证明，也没有任何 omp 快照携带过它。
 */
async function runWithQueuedFollowUpPendingAck(
  options: Parameters<typeof createEngine>[0] = {},
  text = "B 文本",
): Promise<{ harness: EngineHarness; bTurnId: string }> {
  const followUpAckPending = (command: { type: string }): Promise<OmpCommandOutcome> =>
    command.type === "follow_up"
      ? new Promise<OmpCommandOutcome>(() => {})
      : Promise.resolve({ success: true });
  const harness = createEngine({ ...options, sendOutcome: followUpAckPending });
  await harness.engine.sendText("A", "cmd-a", "client");
  harness.onEvent({ type: "agent_start" });
  // sendText 在 beginUserTurn（同步入列排队）之后才进入挂起的 send；race 让用例继续而
  // 不等待永不返回的分发（挂起 Promise 不 reject，无未处理拒绝，进程随 dispose 释放）。
  await Promise.race([harness.engine.sendText(text, "cmd-b", "client"), flushAsync()]);
  assert.equal(harness.engine.projection.hasQueuedTurns(), true);
  const bTurnId = harness
    .rows()
    .find((row) => row.kind === "userInput" && row.text === text)!.turnId;
  return { harness, bTurnId };
}

// ── A3/S4：队列对账 ──
// S4-1/S4-2 语义（omp v18.4.8+fork.278 源码核对）：omp 停止边界会把排队 follow_up 出队
// 合并进同一 run 消费并回答（agent-loop.ts:1754-1763，主流路径），快照「缺席」不再一刀切
// interrupted——曾在快照中在场（seen）且缺席按 drain 消费的合并终态收口；从未 seen 的轮
// 可能仍在入队路上（omp #queueUserMessage 对图片附件有秒级视觉描述延迟，新核输入门串行
// 同理），agent_end 保持排队并触发一次宽限复查，复查仍缺席才 interrupted（绝不误关）。

test("A3①：follow_up ACK 在途未达 + terminal agent_end + get_state 无该消息 → 从未 seen 不立即收口（S4-2 宽限）", async () => {
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck({
    state: () => ({ queuedMessages: { followUp: [] } }),
  });
  try {
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    // 该轮从未被证明入队（ACK 未达、无任何快照在场）：不能立即判 interrupted（可能仍
    // 在入队路上，「绝不误关」），保持排队并触发一次宽限复查。F2b-P1 语义变更：success
    // ACK 已到达的轮此刻即登记 seen 并按合并终态收口（见 F2b-P1①），不再落入本分支。
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "running",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("S4-1①：流式快照在场（seen）→ agent_end 缺席 → 按停止边界 drain 合并终态收口 success", async () => {
  let followUp: string[] = ["B 文本"];
  const harness = createEngine({ state: () => ({ queuedMessages: { followUp } }) });
  try {
    const bTurnId = await runWithQueuedFollowUp(harness);
    // 入队快照（queue_update → debounce get_state）在流式中到达：只登记 seen，不收口。
    harness.onEvent({ type: "queue_update", followUp, steering: [] });
    await sleep(320);
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    // 停止边界 drain：B 被合并进同一 run 消费并回答后 agent_end 到达，队列已无 B——
    // seen 且缺席按合并终态（success）收口，不再误标 interrupted。
    followUp = [];
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedSuccess",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("S4-2②：从未 seen（ACK 在途未达）宽限——agent_end 不收口 → 宽限复查仍缺席 → interrupted 收口", async () => {
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck({
    state: () => ({ queuedMessages: { followUp: [] } }),
  });
  try {
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    // 宽限复查（forceClose）：快照仍无该文本且期间未被任何 queue_update 携带 → interrupted
    // （需求 A1「取消/失败按 interrupted/failed 收口」，不悬挂 running）。
    await sleep(2300);
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedInterrupted",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("S4-2③：宽限复查前文本出现在队列 → 登记 seen；再消失按合并终态收口而非 interrupted", async () => {
  let followUp: string[] = [];
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck({
    state: () => ({ queuedMessages: { followUp } }),
  });
  try {
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    // 宽限窗口内 omp 完成图片描述等延迟入队：queue_update 携带文本 → 快照在场，登记
    // seen，保持排队不收口。
    followUp = ["B 文本"];
    harness.onEvent({ type: "queue_update", followUp, steering: [] });
    await sleep(320);
    assert.equal(harness.engine.projection.hasQueuedTurns(), true, "在场期间不得收口");
    // 复查前又消失（omp 停止边界 drain 消费）：宽限复查按合并终态（success）收口。
    followUp = [];
    await sleep(2100);
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedSuccess",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test('S4-4④："/" 开头排队文本按 chip 前缀匹配——模板展开后的快照不误判缺席', async () => {
  const harness = createEngine({
    state: () => ({ queuedMessages: { followUp: ["/deploy prod --yes --timeout=90s"] } }),
  });
  try {
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    const delivery = await harness.engine.sendText("/deploy prod", "cmd-b", "client");
    assert.equal(delivery, "queue");
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    await flushAsync();
    // omp 队列 chip 是模板展开后的内容（保留斜杠命令形态前缀）：前缀匹配命中 →
    // 保持排队，不因原文全等失败而误判缺席。
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    const bTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "/deploy prod")!.turnId;
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "running",
    );
  } finally {
    await harness.engine.dispose();
  }
});

// ── F2b：ACK 即 seen（P1）与 "/" 命令名段匹配（P2）──
// P1 依据（omp v18.4.8 源码核对）：#queueUserMessage（agent-session.ts:8053-8170）在
// `await session.followUp()/steer()` 完成后才返回，rpc handler 在 await 后才回 success ACK
// ⇒ ACK 到达即已入队；停止边界 drain（agent-loop.ts:1754-1763）可在入队后短于 250ms
// debounce 窗口内消费该消息（queue_update 被 debounce 合并、terminal agent_end 去重还会
// 清掉未触发的定时器），快照可能从未携带——分发 success ACK 到达时立即把分发文本以
// markOnly 单元素快照登记 seen。边界备查：新核输入门（v18.4.10+）取消的 steer/follow_up
// 同样回 success 但未入队（§14.4「success≠入队」），当前内嵌核 v18.4.8 无输入门判据成立。

test("F2b-P1①：快速 drain——follow_up success ACK 即 seen（无需任何快照）→ agent_end 缺席 → 合并终态 success", async () => {
  const harness = createEngine({ state: () => ({ queuedMessages: { followUp: [] } }) });
  try {
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    const delivery = await harness.engine.sendText("B 文本", "cmd-b", "client");
    assert.equal(delivery, "queue");
    // success ACK 已随 sendText 返回到达（⇒ 已入队），全程无任何 queue_update/get_state
    // 快照携带 B：seen 登记只能来自 ACK（修复前该轮「从未 seen」）。停止边界 drain：
    // agent_end 到达时 omp 队列已无 B（快照缺席）——seen 且缺席按合并终态收口 success，
    // 不经过宽限 interrupted（修复前该窗口内被误标 interrupted，实际已被成功回答）。
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    const bTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "B 文本")!.turnId;
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedSuccess",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("F2b-P2②：前缀碰撞——快照仅含 /deploy-prod 时 /deploy 轮不登记 seen（宽限后 interrupted）", async () => {
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck(
    {
      // ACK 在途未达：隔离 P2 快照匹配路径（成功 ACK 会按分发原文自匹配登记 seen）。
      state: () => ({ queuedMessages: { followUp: ["/deploy-prod"] } }),
    },
    "/deploy",
  );
  try {
    // 流式快照只含不同命令的 chip /deploy-prod：命令名段比对不命中（修复前 startsWith
    // 前缀误命中并登记 seen）→ /deploy 保持从未 seen。
    harness.onEvent({ type: "queue_update", followUp: ["/deploy-prod"], steering: [] });
    await sleep(320);
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true, "从未 seen 不得立即收口");
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "running",
    );
    // 宽限复查（forceClose）快照仍只有 /deploy-prod → interrupted 收口（XR-B 实证的修复前
    // 行为：前缀误命中登记 seen 后，随空快照被误收口 success）。
    await sleep(2300);
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedInterrupted",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("F2b-P2③：同命令参数 chip 仍命中——/deploy 命中 /deploy prod --yes 登记 seen，drain 缺席按合并终态 success", async () => {
  let followUp: string[] = ["/deploy prod --yes --timeout=90s"];
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck(
    { state: () => ({ queuedMessages: { followUp } }) },
    "/deploy",
  );
  try {
    // 快照含同命令参数 chip（模板展开形态）：命令名段 + 空格前缀命中 → 登记 seen、
    // 保持排队（ACK 在途未达，seen 只能来自快照匹配——隔离 P2 匹配路径）。
    harness.onEvent({
      type: "queue_update",
      followUp: ["/deploy prod --yes --timeout=90s"],
      steering: [],
    });
    await sleep(320);
    assert.equal(harness.engine.projection.hasQueuedTurns(), true, "在场期间不得收口");
    // 停止边界 drain：chip 消失 → seen 且缺席按合并终态（success）收口，证明参数 chip
    // 确实命中并登记了 seen。
    followUp = [];
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedSuccess",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("A3②：get_state 仍含该消息（旧核冻结）→ 保持排队", async () => {
  const harness = createEngine({ state: () => ({ queuedMessages: { followUp: ["B 文本"] } }) });
  try {
    await runWithQueuedFollowUp(harness);
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
  } finally {
    await harness.engine.dispose();
  }
});

test("A3③：get_state 无 queuedMessages 字段 → 不动（不确定→不动）", async () => {
  const harness = createEngine({ state: () => ({}) });
  try {
    await runWithQueuedFollowUp(harness);
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
  } finally {
    await harness.engine.dispose();
  }
});

test("A3④：queue_update 事件触发 debounce 对账（消息离队后收口）", async () => {
  let followUp: string[] = ["B 文本"];
  const harness = createEngine({ state: () => ({ queuedMessages: { followUp } }) });
  try {
    await runWithQueuedFollowUp(harness);
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    // omp 队列随后不再含该消息（停止边界 drain 已消费/新核取消丢弃）：queue_update 触发
    // 空闲对账——曾在快照在场（seen）且缺席 → 按合并终态收口。
    followUp = [];
    harness.onEvent({ type: "queue_update", followUp: [], steering: [] });
    await sleep(320);
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
  } finally {
    await harness.engine.dispose();
  }
});

// ── XR1：对账 get_state 陈旧快照竞态守卫 ──

test("XR1①：get_state 在途→新排队输入→terminal agent_end→陈旧回包 → 新排队轮不被误收口", async () => {
  // 竞态时序：debounce 对账的 get_state 在途（快照不含后续输入）→ 用户提交 B（本地入
  // queuedTurns、follow_up 已发出但 omp 尚未处理）→ terminal agent_end 在陈旧回包前处理
  // （流式守卫失效）→ 陈旧快照不含 B 文本。输入接受序号守卫必须跳过本轮对账，否则 B 被
  // 误收口 interrupted、后续输出被静默丢弃。
  let deferStates = false;
  const stateResolvers: Array<(state: OmpStateData) => void> = [];
  const harness = createEngine({
    state: () =>
      deferStates
        ? new Promise<OmpStateData>((resolve) => stateResolvers.push(resolve))
        : ({} as OmpStateData),
  });
  try {
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    // 流式中触发对账：queue_update → debounce → get_state #1 在途（捕获序号，尚无 B）。
    harness.onEvent({ type: "queue_update", followUp: [], steering: [] });
    deferStates = true;
    await sleep(320);
    assert.equal(stateResolvers.length, 1, "debounce 对账的 get_state 应在途挂起");

    // get_state 在途期间接受新输入 B：排队（follow_up 已发出，omp 未处理）。
    const delivery = await harness.engine.sendText("B 文本", "cmd-b", "client");
    assert.equal(delivery, "queue");
    const bTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "B 文本")!.turnId;

    // terminal agent_end 先于陈旧回包处理：A 收口、流式结束（另起 get_state #2 在途）。
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(stateResolvers.length, 2, "agent_end 应另起一次状态回读");

    // 陈旧回包（#1，快照早于 B 入队）到达：守卫跳过本轮对账，B 不得被误收口。
    stateResolvers[0]!({ queuedMessages: { followUp: [] } });
    await flushAsync();
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true, "陈旧快照不得误收口新排队轮");
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "running",
    );

    // 新鲜回包（#2，含 B 的 follow_up）到达：正常对账生效——B 在 omp 队列中，保持排队。
    stateResolvers[1]!({ queuedMessages: { followUp: ["B 文本"] } });
    await flushAsync();
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true, "omp 仍持有 B：保持排队");
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "running",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("XR1②：序号未变（无新输入）时对账语义保持——期间无携带的 queue_update 不解除宽限", async () => {
  // 守卫只跳过「在途期间接受了新输入」的对账；无新输入时快照就是当前事实：缺席轮经
  // S4-2 宽限复查后仍按 interrupted 收口（回归：正常对账仍生效，绝不悬挂 running）；
  // 宽限窗口内不携带该文本的 queue_update 只触发默认对账（缺席且从未 seen → 保持排队），
  // 不解除宽限。（F2b-P1 之后「从未 seen」前提由 ACK 在途未达构造，见公共前奏注释。）
  const { harness, bTurnId } = await runWithQueuedFollowUpPendingAck({
    state: () => ({ queuedMessages: { followUp: [] } }),
  });
  try {
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    harness.onEvent({ type: "queue_update", followUp: [], steering: [] });
    await sleep(320);
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    // 宽限复查不被 XR1 守卫跳过（序号未变），到期仍判 interrupted。
    await sleep(2100);
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === bTurnId)?.state,
      "completedInterrupted",
    );
  } finally {
    await harness.engine.dispose();
  }
});

// ── A4：排队时新输入 → agent_start 合并收口更早排队轮 ──

test("A4：新 run 开始不提前清空 B；缺少用户消息事件时终态对账仍收口", async () => {
  let followUp: string[] = [];
  const harness = createEngine({ state: () => ({ queuedMessages: { followUp } }) });
  try {
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    await harness.engine.sendText("B 文本", "cmd-b", "client");
    followUp = ["B 文本"]; // 旧核冻结：omp 仍持有 B
    harness.onEvent({ type: "agent_end" }); // A 收口；对账保持 B 排队
    await flushAsync();
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);

    // 新输入 C（非流式 → startNow 直接成当前轮）；omp 将在新 run 内合并消费 B。
    followUp = [];
    const cDelivery = await harness.engine.sendText("C 文本", "cmd-c", "client");
    assert.equal(cDelivery, "startNow");
    harness.onEvent({ type: "agent_start" }); // run 开始不能冒充 B 已消费。
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    streamText(harness, "C 的回复");
    harness.onEvent({ type: "agent_end" });
    await flushAsync();

    const states = headerStates(harness);
    // 无悬挂 running 轮；B 与 C 各自收口、输出归属各自轮次头（合并语义下 B 的回复归 C）。
    assert.ok(states.every((header) => header.state !== "running"));
    const cTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "C 文本")!.turnId;
    const bTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "B 文本")!.turnId;
    assert.equal(states.find((header) => header.turnId === bTurnId)?.state, "completedSuccess");
    assert.equal(states.find((header) => header.turnId === cTurnId)?.state, "completedSuccess");
    assert.deepEqual(assistantTextsOf(harness, cTurnId), ["C 的回复"]);
    assert.deepEqual(assistantTextsOf(harness, bTurnId), []);
  } finally {
    await harness.engine.dispose();
  }
});

// ── A5：guide 与 terminal agent_end 竞态 ──

function steerDeferredHarness() {
  let releaseSteer!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSteer = resolve;
  });
  const harness = createEngine({
    sendOutcome: (command) =>
      command.type === "steer"
        ? gate.then(() => ({ success: true }))
        : Promise.resolve({ success: true }),
  });
  return { harness, releaseSteer };
}

test("A5 竞态：agent_end 插在 beginUserTurn(guide) 与 steer 响应之间 → guide 轮转回排队并承接 drain", async () => {
  const { harness, releaseSteer } = steerDeferredHarness();
  try {
    harness.engine.setFollowupMode("guide");
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    streamText(harness, "A 输出");
    const guideSend = harness.engine.sendText("G 引导", "cmd-g", "client");
    // steer 在途：terminal agent_end 到达（旧轮被收口，guide 轮无内容 → 转回排队）。
    harness.onEvent({ type: "agent_end" });
    const aTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "A")!.turnId;
    const gTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "G 引导")!.turnId;
    assert.equal(
      headerStates(harness).find((header) => header.turnId === aTurnId)?.state,
      "completedSuccess",
    );
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === gTurnId)?.state,
      "running",
    );

    releaseSteer();
    assert.equal(await guideSend, "queue");
    assert.equal(harness.engine.projection.hasQueuedTurns(), true); // steer 成功：仍排队等激活

    // drain 回合：agent_start 激活 guide 轮，输出归属该轮并正常收口。
    harness.onEvent({ type: "agent_start" });
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    streamText(harness, "G 的输出");
    harness.onEvent({ type: "agent_end" });
    await flushAsync();

    assert.deepEqual(assistantTextsOf(harness, gTurnId), ["G 的输出"]);
    assert.equal(
      headerStates(harness).find((header) => header.turnId === gTurnId)?.state,
      "completedSuccess",
    );
    assert.ok(headerStates(harness).every((header) => header.state !== "running"));
  } finally {
    await harness.engine.dispose();
  }
});

test("A5 竞态失败路径：steer 响应失败 → 转回排队的 guide 轮按 sourceCommand 收口 failed", async () => {
  let releaseSteer!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSteer = resolve;
  });
  const harness = createEngine({
    sendOutcome: (command) =>
      command.type === "steer"
        ? gate.then(() => ({ success: false, error: "steer rejected" }))
        : Promise.resolve({ success: true }),
  });
  try {
    harness.engine.setFollowupMode("guide");
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    const guideSend = harness.engine.sendText("G 引导", "cmd-g", "client");
    harness.onEvent({ type: "agent_end" });
    assert.equal(harness.engine.projection.hasQueuedTurns(), true);
    releaseSteer();
    await guideSend;
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    const gTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "G 引导")!.turnId;
    assert.equal(
      headerStates(harness).find((header) => header.turnId === gTurnId)?.state,
      "failed",
    );
  } finally {
    await harness.engine.dispose();
  }
});

test("A5 正常时序：steer 响应先返回 → agent_end 一次性收口挂起旧轮与 guide 轮（行为不变）", async () => {
  const harness = createEngine(); // steer 立即成功
  try {
    harness.engine.setFollowupMode("guide");
    await harness.engine.sendText("A", "cmd-a", "client");
    harness.onEvent({ type: "agent_start" });
    streamText(harness, "A 输出");
    const delivery = await harness.engine.sendText("G 引导", "cmd-g", "client");
    assert.equal(delivery, "queue");
    streamText(harness, "G 的输出");
    harness.onEvent({ type: "agent_end" });
    await flushAsync();
    const states = headerStates(harness);
    assert.ok(states.every((header) => header.state === "completedSuccess"));
    assert.equal(harness.engine.projection.hasQueuedTurns(), false);
    const gTurnId = harness
      .rows()
      .find((row) => row.kind === "userInput" && row.text === "G 引导")!.turnId;
    assert.deepEqual(assistantTextsOf(harness, gTurnId), ["G 的输出"]);
  } finally {
    await harness.engine.dispose();
  }
});
