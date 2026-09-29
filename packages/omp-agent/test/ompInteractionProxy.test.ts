import assert from "node:assert/strict";
import { test } from "node:test";
import { OmpInteractionProxy } from "../src/app/ompInteractionProxy.js";

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

// ── v3 fork surface：结构化审批与富 ask（rpc-ui-protocol 4.1/4.3）──

interface ProxyHarnessOptions {
  gateway?: {
    requestUserInput?: (params: { prompt: string; questions?: unknown[] }) => Promise<unknown>;
    requestPermission?: (params: Record<string, unknown>) => Promise<unknown>;
  };
  anchorRowId?: number | null;
}

function createV3Proxy(options: ProxyHarnessOptions = {}) {
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
      ...(options.gateway?.requestPermission
        ? { requestPermission: options.gateway.requestPermission }
        : {}),
    } as never,
    addPendingInteraction: (interaction) => pending.push(interaction),
    resolvePendingInteraction: (id) => resolved.push(id),
    scheduleFlush() {},
    ...(options.anchorRowId !== undefined ? { anchorRowIdOf: () => options.anchorRowId! } : {}),
  });
  return { proxy, pending, resolved, responses };
}

test("v3 permission：投影权限卡并经 v4 settle 回传 reject_once+feedback；无反向请求面也收敛", async () => {
  const { proxy, pending, resolved, responses } = createV3Proxy();
  const request = {
    frame: {
      type: "permission_request" as const,
      id: "perm-9",
      toolCallId: "toolu-9",
      toolName: "write",
      tier: "write" as const,
      reason: "Approve write",
      approvalMode: "write" as const,
      details: ["path: a.txt"],
      input: { path: "a.txt" },
      origin: { subagentId: "child-1", agentType: "scout" },
    },
    respond: (response: unknown) => responses.push(response),
  };
  const handled = proxy.handlePermission(request);
  assert.equal(pending.length, 1);
  const interactionId = pending[0]!.interactionId;
  assert.equal(pending[0]!.payload.kind, "permission");
  assert.equal(pending[0]!.payload.toolCallId, "toolu-9");
  assert.deepEqual(pending[0]!.payload.origin, {
    kind: "subagent",
    agentId: "child-1",
    agentType: "scout",
    childSessionId: "child-1",
    parentSessionId: "session-1",
  });
  const optionIds = (pending[0]!.payload.options as { optionId: string }[]).map(
    (option) => option.optionId,
  );
  assert.deepEqual(optionIds, ["allowOnce", "allowSession", "allowAlways", "deny", "denyAlways"]);
  // UI 经 v4 resolveInteraction 拒绝并附理由 → reject_once + feedback（fail-closed）。
  assert.equal(
    proxy.settle(interactionId, { action: "accept", optionId: "deny", freeText: "先停一下" }),
    true,
  );
  await handled;
  assert.deepEqual(responses, [
    { type: "permission_response", id: "perm-9", option: "reject_once", feedback: "先停一下" },
  ]);
  assert.deepEqual(resolved, [interactionId]);
});

test("v3 permission：宿主反向请求应答 allow → allow_once；无 gateway.requestPermission 时不挂起", async () => {
  const { proxy, responses } = createV3Proxy({
    gateway: {
      requestPermission: async (params) => {
        assert.equal(params.toolName, "bash");
        assert.equal(params.riskLevel, "high");
        return { decision: "allow" };
      },
    },
  });
  await proxy.handlePermission({
    frame: {
      type: "permission_request",
      id: "perm-10",
      toolCallId: "toolu-10",
      toolName: "bash",
      tier: "exec",
      approvalMode: "write",
      details: ["npm install"],
      input: { command: "npm install" },
      prefixSuggestion: "npm ",
    },
    respond: (response) => responses.push(response),
  });
  assert.deepEqual(responses, [
    { type: "permission_response", id: "perm-10", option: "allow_once" },
  ]);
});

test("v3 ask：投影富问题集与倒计时；snooze 触发 pause；应答经 content 解析", async () => {
  let pauseCalls = 0;
  let questionsArg: unknown;
  const { proxy, pending, responses } = createV3Proxy({
    gateway: {
      requestUserInput: async (params) => {
        questionsArg = params.questions;
        return { action: "accept", content: { answer_0: ["Postgres"] } };
      },
    },
  });
  const deadlineAt = Date.now() + 60_000;
  const handled = proxy.handleAsk({
    frame: {
      type: "ask_request",
      id: "ask-9",
      questions: [
        {
          id: "q1",
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
          multi: true,
        },
      ],
      note: "Choose",
      timeoutMs: 60_000,
      deadlineAt,
    },
    respond: (response) => responses.push(response),
    pause: () => {
      pauseCalls += 1;
    },
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.payload.toolName, "AskUserQuestion");
  assert.deepEqual((pending[0]!.autoResolution as { deadlineAt: number }).deadlineAt, deadlineAt);
  assert.match(JSON.stringify(questionsArg), /Which database/);
  // 首次交互幂等暂停：仅 ask 类交互可 snooze；重复调用仍幂等。
  const interactionId = pending[0]!.interactionId;
  assert.equal(proxy.snooze(interactionId), true);
  assert.equal(pauseCalls, 1);
  assert.equal(
    proxy.settle(interactionId, { action: "accept", content: { answer_0: ["Postgres"] } }),
    true,
  );
  await handled;
  assert.deepEqual(responses, [
    { type: "ask_response", id: "ask-9", answers: [{ questionId: "q1", selected: ["Postgres"] }] },
  ]);
});

test("v3 ask：服务端到期自动收尾后本地清场，不再发应答帧；非 ask 交互不可 snooze", async () => {
  const { proxy, pending, resolved, responses } = createV3Proxy({
    // 反向请求挂起不决（模拟宿主未应答）：只有服务端到期路径能收口。
    gateway: {
      requestUserInput: () => new Promise(() => {}),
    },
  });
  await proxy.handleAsk({
    frame: {
      type: "ask_request",
      id: "ask-10",
      questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }],
      deadlineAt: Date.now() + 40,
    },
    respond: (response) => responses.push(response),
    pause: () => {},
  });
  // 非 ask 交互（无到期语义的 ui 请求）snooze 返回 false。
  assert.equal(proxy.snooze("unknown-id"), false);
  await new Promise((sleep) => setTimeout(sleep, 160));
  assert.deepEqual(responses, [], "到期后不应再发 ask_response");
  // 到期清场与 awaitAnswer 收尾各清一次 pending（幂等），去重后应恰为该交互。
  assert.deepEqual([...new Set(resolved)], [pending[0]!.interactionId]);
  // 迟到的 settle 不再命中。
  assert.equal(proxy.settle(pending[0]!.interactionId, { action: "accept", optionId: "A" }), false);
});
