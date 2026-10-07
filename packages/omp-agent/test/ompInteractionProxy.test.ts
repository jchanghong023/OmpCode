import assert from "node:assert/strict";
import { test } from "node:test";
import { OmpInteractionProxy } from "../src/app/ompInteractionProxy.js";
import { dispatchOmpUiFrame } from "../src/adapters/ompUiFrames.js";

test("rpc-ui editor 自由文本经现有交互路径返回同一请求", async () => {
  const pending: { interactionId: string; payload: unknown }[] = [];
  const resolved: string[] = [];
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput(params) {
        assert.equal(params.prompt, "补充说明");
        return { action: "accept", freeText: "需要保留旧数据" };
      },
    },
    addPendingInteraction: (interaction) => pending.push(interaction),
    resolvePendingInteraction: (id) => resolved.push(id),
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-1", method: "editor", title: "补充说明" },
    respond: (response) => responses.push(response),
  });

  assert.equal(pending.length, 1);
  assert.deepEqual(
    resolved,
    pending.map((interaction) => interaction.interactionId),
  );
  assert.deepEqual(pending[0]?.payload, {
    kind: "userInput",
    prompt: "补充说明",
    freeText: true,
    answerMode: "text",
    allowCustomInput: true,
    questions: [{ question: "补充说明", header: "补充说明", options: [] }],
  });
  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-1", value: "需要保留旧数据" },
  ]);
});

test("rpc-ui select 投影为 ZCode 既有问答题并保留选项说明", async () => {
  let payload: unknown;
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "accept", optionId: "保留" };
      },
    },
    addPendingInteraction(interaction) {
      payload = interaction.payload;
    },
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: {
      id: "omp-ui-choice",
      method: "select",
      title: "数据处理",
      options: ["保留", "删除"],
      optionDetails: [{ description: "原有数据继续可用" }, {}],
    },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(payload, {
    kind: "userInput",
    prompt: "数据处理",
    freeText: false,
    options: [
      { optionId: "保留", label: "保留" },
      { optionId: "删除", label: "删除" },
    ],
    answerMode: "option",
    allowCustomInput: false,
    questions: [
      {
        question: "数据处理",
        header: "数据处理",
        options: [
          { value: "保留", label: "保留", description: "原有数据继续可用" },
          { value: "删除", label: "删除" },
        ],
      },
    ],
  });
  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-choice", value: "保留" },
  ]);
});

test("rpc-ui editor 取消按取消回执收口", async () => {
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "cancel" };
      },
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-2", method: "editor", title: "补充说明" },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "omp-ui-2", cancelled: true }]);
});

// ── S5-1：extension_ui select/input/editor 的 decline 一律回 cancelled（omp 侧取消语义 =
// {cancelled:true}，parseValueDialogResponse 仅直通 "value"）。select 是通用扩展选择框，
// 「dismiss≈deny」不成立；合成「deny/末位选项」会把用户关闭对话框上报为选中肯定选项（fail-open）。

test("S5-1: select decline 回 cancelled，即使选项里含 Deny/肯定末位选项也不合成 value", async () => {
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "decline" };
      },
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: {
      id: "omp-ui-install",
      method: "select",
      title: "安装插件？",
      options: ["Install", "Cancel install"],
    },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-install", cancelled: true },
  ]);
});

test("S5-1: input decline 回 cancelled，不回空 value", async () => {
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "decline" };
      },
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-3", method: "input", title: "请输入" },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "omp-ui-3", cancelled: true }]);
});

// ── S5-2：omp 主动取消帧 {method:"cancel", targetId:<原请求id>}（cancelHostDialog/onAbort）
// 必须立即结束等待中的交互，而不是残留至本地预算兜底。

test("S5-2: cancel 帧按 targetId 反查并取消等待中的交互，原请求回 cancelled", async () => {
  const responses: unknown[] = [];
  const resolved: string[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    // 反向请求挂起不决（模拟宿主未应答）：只有 omp cancel 帧能收口。
    gateway: {
      emitFrame() {},
      requestUserInput: () => new Promise(() => {}),
    },
    addPendingInteraction() {},
    resolvePendingInteraction: (id) => resolved.push(id),
    scheduleFlush() {},
  });
  const handled = proxy.handle({
    frame: { id: "omp-ui-9", method: "select", title: "选择", options: ["A", "B"] },
    respond: (response) => responses.push(response),
  });

  // omp abort 后发 cancel 帧（id 为新 snowflake，targetId 指向原请求）。
  await proxy.handle({
    frame: { id: "cancel-frame-1", method: "cancel", targetId: "omp-ui-9" },
    respond: (response) => responses.push(response),
  });

  await handled;
  // cancel 帧同步回执；原 select 请求经 settle 微任务收口，顺序不确定，按 id 归一后断言。
  assert.deepEqual(
    [...responses]
      .map((response) => response as { type: string; id: string; cancelled?: boolean })
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { type: "extension_ui_response", id: "cancel-frame-1", cancelled: true },
      { type: "extension_ui_response", id: "omp-ui-9", cancelled: true },
    ],
  );
  assert.equal(resolved.length, 1, "等待中的 pendingInteraction 应被立即清场");
  // 未知 targetId / 已收口后的重复 cancel 均为无害 no-op。
  await proxy.handle({
    frame: { id: "cancel-frame-2", method: "cancel", targetId: "omp-ui-unknown" },
    respond: (response) => responses.push(response),
  });
  assert.equal(resolved.length, 1);
});

// ── S5-4：editor prefill 透传（初始文本）与 accept 空文本语义。

test("S5-4: editor prefill 携带进 pendingInteraction payload 供宿主作初始文本", async () => {
  const pending: { interactionId: string; payload: unknown }[] = [];
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "accept", freeText: "改好的文本" };
      },
    },
    addPendingInteraction: (interaction) => pending.push(interaction),
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-4", method: "editor", title: "补充说明", prefill: "草稿内容" },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(pending[0]?.payload, {
    kind: "userInput",
    prompt: "补充说明",
    freeText: true,
    prefill: "草稿内容",
    answerMode: "text",
    allowCustomInput: true,
    questions: [{ question: "补充说明", header: "补充说明", options: [] }],
  });
  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-4", value: "改好的文本" },
  ]);
});

test("S5-4: editor accept 而无文本回 cancelled（空串会被 omp 直通采纳为编辑结果、丢失原文）", async () => {
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "accept", freeText: "" };
      },
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-5", method: "editor", title: "补充说明", prefill: "草稿" },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "omp-ui-5", cancelled: true }]);
});

// ── 富 ask（extension_ui_request method:"ask"，set_ask_dialog 启用后）──

interface ProxyHarnessOptions {
  gateway?: {
    requestUserInput?: (params: { prompt: string; questions?: unknown[] }) => Promise<unknown>;
  };
}

function createAskProxy(options: ProxyHarnessOptions = {}) {
  const pending: import("@zcode/shared/zcode-protocol-v4").PendingInteraction[] = [];
  const resolved: string[] = [];
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      ...(options.gateway?.requestUserInput
        ? { requestUserInput: options.gateway.requestUserInput }
        : {}),
    },
    addPendingInteraction: (interaction) => pending.push(interaction),
    resolvePendingInteraction: (id) => resolved.push(id),
    scheduleFlush() {},
  });
  return { proxy, pending, resolved, responses };
}

test("富 ask：投影富问题集与倒计时；应答按题 answers（id 对齐题目 id）", async () => {
  let questionsArg: unknown;
  const { proxy, pending, responses } = createAskProxy({
    gateway: {
      requestUserInput: async (params) => {
        questionsArg = params.questions;
        return { action: "accept", content: { answer_0: ["Postgres"] } };
      },
    },
  });
  const handled = proxy.handleAsk({
    frame: {
      id: "ask-9",
      questions: [
        {
          id: "q1",
          question: "Which database?",
          header: "Database",
          options: [{ label: "Postgres", preview: "SELECT 1;" }, { label: "SQLite" }],
          multi: true,
        },
        {
          id: "q2",
          question: "Enable cache?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
      timeoutMs: 60_000,
    },
    respond: (response: unknown) => responses.push(response),
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.payload.toolName, "AskUserQuestion");
  assert.ok((pending[0]!.autoResolution as { deadlineAt?: number } | undefined)?.deadlineAt);
  assert.match(JSON.stringify(questionsArg), /Which database/);
  // snooze（v4 首次交互）仅顺延本地预算：服务端倒计时继续，不再发协议帧。
  const interactionId = pending[0]!.interactionId;
  assert.equal(proxy.snooze(interactionId), true);
  assert.equal(
    proxy.settle(interactionId, {
      action: "accept",
      content: { answer_0: ["Postgres"], answer_1: ["Yes"] },
    }),
    true,
  );
  await handled;
  assert.deepEqual(responses, [
    {
      type: "extension_ui_response",
      id: "ask-9",
      answers: [
        { id: "q1", selectedOptions: ["Postgres"] },
        { id: "q2", selectedOptions: ["Yes"] },
      ],
    },
  ]);
});

test("富 ask：服务端到期自动收尾后本地清场，不再发应答帧；非 ask 交互不可 snooze", async () => {
  const { proxy, pending, resolved, responses } = createAskProxy({
    // 反向请求挂起不决（模拟宿主未应答）：只有服务端到期路径能收口。
    gateway: {
      requestUserInput: () => new Promise(() => {}),
    },
  });
  await proxy.handleAsk({
    frame: {
      id: "ask-10",
      questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }],
      timeoutMs: 40,
    },
    respond: (response: unknown) => responses.push(response),
  });
  // 非 ask 交互（无到期语义的 ui 请求）snooze 返回 false。
  assert.equal(proxy.snooze("unknown-id"), false);
  await new Promise((sleep) => setTimeout(sleep, 160));
  assert.deepEqual(responses, [], "到期后不应再发应答帧");
  // 到期清场与 awaitAnswer 收尾各清一次 pending（幂等），去重后应恰为该交互。
  assert.deepEqual([...new Set(resolved)], [pending[0]!.interactionId]);
  // 迟到的 settle 不再命中。
  assert.equal(proxy.settle(pending[0]!.interactionId, { action: "accept", optionId: "A" }), false);
});

// ── B1：反向 UI 请求帧解析失败回终止响应（「未知交互不能静默忽略，应回传不支持以
// 终止等待」；omp 侧等待无超时，吞帧=对端永久挂起）──

function createUiFrameHarness() {
  const responses: unknown[] = [];
  const fired: string[] = [];
  return {
    responses,
    fired,
    handlers: {
      onUiRequest: () => fired.push("ui"),
      onAskRequest: () => fired.push("ask"),
      respond: (frame: unknown) => responses.push(frame),
    },
  };
}

test("B1: 畸形 extension_ui_request 回 cancelled 终止响应，handlers 不触发", () => {
  const harness = createUiFrameHarness();
  // method 已是自由字符串（schema 放宽），解析失败以畸形字段驱动：options 非数组。
  const consumed = dispatchOmpUiFrame(
    { type: "extension_ui_request", id: "ui-x", method: "select", options: { bad: true } },
    harness.handlers,
  );
  assert.equal(consumed, true, "该类帧必须被消费（不落主分发）");
  assert.deepEqual(harness.responses, [
    { type: "extension_ui_response", id: "ui-x", cancelled: true },
  ]);
  assert.deepEqual(harness.fired, []);
});

test("B1: 畸形 questions 的 ask 帧回 cancelled；id 缺失时无法回执仅吞帧不抛错", () => {
  const harness = createUiFrameHarness();
  assert.equal(
    dispatchOmpUiFrame(
      { type: "extension_ui_request", id: "ask-x", method: "ask", questions: { bad: true } },
      harness.handlers,
    ),
    true,
  );
  assert.deepEqual(harness.responses, [
    { type: "extension_ui_response", id: "ask-x", cancelled: true },
  ]);
  assert.deepEqual(harness.fired, []);

  // id 非 string：无法回执（无法定位等待方），帧仍消费但不得抛错。
  const noId = createUiFrameHarness();
  assert.equal(
    dispatchOmpUiFrame({ type: "extension_ui_request", id: 42, method: "select" }, noId.handlers),
    true,
  );
  assert.deepEqual(noId.responses, []);
  assert.deepEqual(noId.fired, []);
});

test("method:ask + 合法问题集 → onAskRequest 分发（不落 onUiRequest）", () => {
  const harness = createUiFrameHarness();
  assert.equal(
    dispatchOmpUiFrame(
      {
        type: "extension_ui_request",
        id: "ask-ok",
        method: "ask",
        questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }],
      },
      harness.handlers,
    ),
    true,
  );
  assert.deepEqual(harness.fired, ["ask"]);
  assert.deepEqual(harness.responses, []);
});

test("B1: 合法帧照常分发且不回终止响应（回归保护）", () => {
  const harness = createUiFrameHarness();
  assert.equal(
    dispatchOmpUiFrame(
      { type: "extension_ui_request", id: "ui-ok", method: "select", title: "T", options: ["a"] },
      harness.handlers,
    ),
    true,
  );
  assert.deepEqual(harness.fired, ["ui"]);
  assert.deepEqual(harness.responses, []);
});
