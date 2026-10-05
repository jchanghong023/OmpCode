// v3 fork surface 交互映射纯函数 UT（ompInteractionMapping）：六档选项、fail-closed、
// ask 应答解析与倒计时暂停契约。wire 级闭环由 adapter.e2e.test.ts 的 v3 用例覆盖。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askDeadlineOf,
  askResponseOf,
  ompOriginToZcode,
  permissionHostAnswerOf,
  permissionOptionsOf,
  permissionResponseOf,
  permissionRiskLevelOf,
} from "../src/app/ompInteractionMapping.js";
import { OmpInteractionProxy } from "../src/app/ompInteractionProxy.js";
import { ompExtensionUiRequestFrameSchema } from "../src/domain/ompFrames.js";
import {
  ompPermissionRequestFrameSchema,
  type OmpAskRequestFrame,
  type OmpBypassFrame,
  type OmpPermissionRequestFrame,
} from "../src/domain/ompForkFrames.js";

function permissionFrame(
  overrides: Partial<OmpPermissionRequestFrame> = {},
): OmpPermissionRequestFrame {
  return {
    type: "permission_request",
    id: "perm-1",
    toolCallId: "toolu-1",
    toolName: "write",
    tier: "write",
    approvalMode: "write",
    details: ["path: greeting.txt"],
    input: { path: "greeting.txt" },
    ...overrides,
  };
}

function askFrame(overrides: Partial<OmpAskRequestFrame> = {}): OmpAskRequestFrame {
  return {
    type: "ask_request",
    id: "ask-1",
    questions: [
      {
        id: "q-db",
        question: "Which database?",
        options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }],
        multi: true,
      },
      { id: "q-cache", question: "Enable cache?", options: [{ label: "Yes" }, { label: "No" }] },
    ],
    ...overrides,
  };
}

test("permissionOptionsOf：基础四档 + 会话档；前缀档仅携带 prefixSuggestion 时投放", () => {
  const base = permissionOptionsOf(permissionFrame());
  assert.deepEqual(
    base.map((option) => option.omp),
    ["allow_once", "allow_session", "allow_always", "reject_once", "reject_always"],
  );
  assert.deepEqual(
    base.map((option) => option.optionId),
    ["allowOnce", "allowSession", "allowAlways", "deny", "denyAlways"],
  );
  const withPrefix = permissionOptionsOf(permissionFrame({ prefixSuggestion: "npm " }));
  assert.equal(withPrefix.length, 6);
  const prefix = withPrefix.find((option) => option.omp === "allow_always_prefix");
  assert.equal(prefix?.optionId, "allowAlwaysPrefix");
  assert.match(prefix?.label ?? "", /npm/);
});

test("permissionResponseOf：allow/reject 与 feedback 语义映射；取消与未知应答 fail-closed", () => {
  const options = permissionOptionsOf(permissionFrame());
  assert.deepEqual(
    permissionResponseOf(permissionFrame(), options, {
      action: "accept",
      optionId: "allowSession",
    }),
    {
      type: "permission_response",
      id: "perm-1",
      option: "allow_session",
    },
  );
  // UI 权限卡的 deny+理由：reject_once 且 feedback 回传附给模型。
  assert.deepEqual(
    permissionResponseOf(permissionFrame(), options, {
      action: "accept",
      optionId: "deny",
      freeText: "不要动这个文件",
    }),
    {
      type: "permission_response",
      id: "perm-1",
      option: "reject_once",
      feedback: "不要动这个文件",
    },
  );
  // 未知 optionId 但带自由文本：视为拒绝理由（fail-closed 不放行）。
  assert.deepEqual(
    permissionResponseOf(permissionFrame(), options, {
      action: "accept",
      optionId: "mystery",
      freeText: "先等等",
    }),
    { type: "permission_response", id: "perm-1", option: "reject_once", feedback: "先等等" },
  );
  // 取消 / 纯未知：裸 reject_once，绝不静默放行。
  assert.deepEqual(permissionResponseOf(permissionFrame(), options, { action: "cancel" }), {
    type: "permission_response",
    id: "perm-1",
    option: "reject_once",
  });
  assert.deepEqual(
    permissionResponseOf(permissionFrame(), options, { action: "accept", optionId: "mystery" }),
    {
      type: "permission_response",
      id: "perm-1",
      option: "reject_once",
    },
  );
});

test("permissionHostAnswerOf：allow 直通；deny/escalate/modify 一律收口为拒绝", () => {
  assert.deepEqual(permissionHostAnswerOf({ decision: "allow" }), {
    action: "accept",
    optionId: "allowOnce",
  });
  assert.deepEqual(permissionHostAnswerOf({ decision: "deny", reason: "风险太高" }), {
    action: "accept",
    optionId: "deny",
    freeText: "风险太高",
  });
  assert.deepEqual(permissionHostAnswerOf({ decision: "deny" }), { action: "decline" });
  assert.deepEqual(permissionHostAnswerOf({ decision: "escalate" }), { action: "decline" });
  assert.deepEqual(permissionHostAnswerOf({ decision: "modify" }), { action: "decline" });
});

test("permissionRiskLevelOf 与 ompOriginToZcode：tier 分级与子代理来源结构", () => {
  assert.equal(permissionRiskLevelOf("read"), "low");
  assert.equal(permissionRiskLevelOf("write"), "medium");
  assert.equal(permissionRiskLevelOf("exec"), "high");
  assert.deepEqual(ompOriginToZcode(undefined, "session-1"), undefined);
  assert.deepEqual(ompOriginToZcode({ subagentId: "child-9", agentType: "scout" }, "session-1"), {
    kind: "subagent",
    agentId: "child-9",
    agentType: "scout",
    childSessionId: "child-9",
    parentSessionId: "session-1",
  });
});

// ── A7：schema 放宽 + fail-closed ──

test("A7：未知 tier/approvalMode/缺失 details 的权限帧 parse 成功（tier 映射走保守分支）", () => {
  const parsed = ompPermissionRequestFrameSchema.safeParse({
    type: "permission_request",
    id: "perm-x",
    toolCallId: "toolu-x",
    toolName: "bash",
    tier: "admin", // omp 演进新增档位：不拒帧
    approvalMode: "future-mode",
    input: { command: "rm -rf /" },
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.tier, "admin");
  assert.deepEqual(parsed.data.details, []); // 线格式可选，缺省补 []
  // 未知档位按最高风险呈现（fail-closed：绝不降级为 low）。
  assert.equal(permissionRiskLevelOf(parsed.data.tier), "high");
  assert.equal(permissionRiskLevelOf("exec"), "high");
});

test("A7：未知 method 的 extension_ui_request 帧 parse 成功且交互代理按取消回执（不放行）", async () => {
  // omp 真实值 "ask"（rpc-types.ts RpcExtensionUIRequest）与未来演进值都必须可解析。
  for (const method of ["ask", "setWidget", "future-method"]) {
    const parsed = ompExtensionUiRequestFrameSchema.safeParse({
      type: "extension_ui_request",
      id: "ui-1",
      method,
    });
    assert.equal(parsed.success, true, method);
  }
  // 交互代理对未知 method 的保守路径：立即按 cancelled 回执，不让 omp 挂起、不自动放行。
  const responses: OmpBypassFrame[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "s",
    gateway: {
      emitFrame() {},
      requestUserInput: async () => ({ action: "accept", freeText: "应当不被使用" }),
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });
  await proxy.handle({
    frame: { id: "ui-2", method: "ask", title: "哪种数据库？" },
    respond: (response) => {
      responses.push(response);
    },
  });
  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "ui-2", cancelled: true }]);
});

// S5-2/S5-4：omp 主动取消帧与 editor prefill 的线格式字段必须 parse 保留
// （rpc-types.ts RpcExtensionUIRequest：cancel 变体 targetId、editor 变体 prefill；
// 此前 zod 剥离导致代理无法定位等待交互、宿主编辑框丢初始文本）。
test("S5-2/S5-4：cancel.targetId 与 editor.prefill 帧字段 parse 保留", () => {
  const cancel = ompExtensionUiRequestFrameSchema.safeParse({
    type: "extension_ui_request",
    id: "cancel-1",
    method: "cancel",
    targetId: "omp-ui-9",
  });
  assert.equal(cancel.success, true);
  if (cancel.success) {
    assert.equal(cancel.data.method, "cancel");
    assert.equal(cancel.data.targetId, "omp-ui-9");
  }
  const editor = ompExtensionUiRequestFrameSchema.safeParse({
    type: "extension_ui_request",
    id: "omp-ui-4",
    method: "editor",
    title: "补充说明",
    prefill: "草稿内容",
    promptStyle: true,
  });
  assert.equal(editor.success, true);
  if (editor.success) {
    assert.equal(editor.data.prefill, "草稿内容");
  }
});

test("askResponseOf：content.answers 与 answer_N 双格式解析，含多选、其他与空提交", () => {
  // answer_N 数组保真优先；未知标签进 other。
  assert.deepEqual(
    askResponseOf(askFrame(), {
      action: "accept",
      content: { answer_0: ["Postgres"], answer_1: "Later" },
    }),
    {
      type: "ask_response",
      id: "ask-1",
      answers: [
        { questionId: "q-db", selected: ["Postgres"] },
        { questionId: "q-cache", selected: [], other: "Later" },
      ],
    },
  );
  // answers 按题文本连接（", " 切分）；混合标签与自定义。
  assert.deepEqual(
    askResponseOf(askFrame(), {
      action: "accept",
      content: { answers: { "Which database?": "Postgres, SQLite", "Enable cache?": "Yes" } },
    }),
    {
      type: "ask_response",
      id: "ask-1",
      answers: [
        { questionId: "q-db", selected: ["Postgres", "SQLite"] },
        { questionId: "q-cache", selected: ["Yes"] },
      ],
    },
  );
  // 无结构答案的自由文本：单题落 other，多题转对话（辅助对话语义）。
  assert.deepEqual(
    askResponseOf(askFrame({ questions: askFrame().questions.slice(0, 1) }), {
      action: "accept",
      freeText: "都行",
    }),
    {
      type: "ask_response",
      id: "ask-1",
      answers: [{ questionId: "q-db", selected: [], other: "都行" }],
    },
  );
  assert.deepEqual(askResponseOf(askFrame(), { action: "accept", freeText: "就聊一下" }), {
    type: "ask_response",
    id: "ask-1",
    chat: "就聊一下",
  });
  // optionId 命中某题选项：该题选中，其余题空。
  assert.deepEqual(
    askResponseOf(askFrame({ questions: askFrame().questions.slice(1) }), {
      action: "accept",
      optionId: "No",
    }),
    {
      type: "ask_response",
      id: "ask-1",
      answers: [{ questionId: "q-cache", selected: ["No"] }],
    },
  );
  // 空提交 = 合法「全不选」/显式跳过；decline/cancel = 整个 ask abort。
  assert.deepEqual(askResponseOf(askFrame(), { action: "accept", content: {} }), {
    type: "ask_response",
    id: "ask-1",
    answers: [
      { questionId: "q-db", selected: [] },
      { questionId: "q-cache", selected: [] },
    ],
  });
  assert.deepEqual(askResponseOf(askFrame(), { action: "decline" }), {
    type: "ask_response",
    id: "ask-1",
    cancelled: true,
  });
  assert.deepEqual(askResponseOf(askFrame(), { action: "cancel" }), {
    type: "ask_response",
    id: "ask-1",
    cancelled: true,
  });
});

test("askDeadlineOf：优先 deadlineAt，其次 timeoutMs 换算，缺省无倒计时", () => {
  const before = Date.now();
  assert.equal(askDeadlineOf(askFrame({ deadlineAt: 12345 })), 12345);
  const converted = askDeadlineOf(askFrame({ timeoutMs: 5000 }));
  const after = Date.now();
  // now ∈ [before, after] → converted - after ∈ (0, 5000]。
  assert.ok(converted !== undefined && converted - before >= 5000 && converted - after <= 5000);
  assert.equal(askDeadlineOf(askFrame()), undefined);
  assert.equal(askDeadlineOf(askFrame({ timeoutMs: 0 })), undefined);
});
