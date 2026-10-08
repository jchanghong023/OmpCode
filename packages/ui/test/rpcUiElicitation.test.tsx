import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeElicitationRequest } from "@zcode/shared";
import { ElicitationDialog } from "../src/ElicitationDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "../src/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "../src/v4/V4UserInputDialog.js";

function renderAsk(request: ZCodeElicitationRequest, allowCustomInput: boolean): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ElicitationDialog, { request, allowCustomInput, onRespond() {} }),
    ),
  );
}

test("rpc-ui 选择题使用 ZCode Ask 界面并展示选项说明", () => {
  const request: ZCodeElicitationRequest = {
    type: "elicitation_request",
    taskId: "session-1",
    traceId: "session-1",
    requestId: "ask-1",
    message: "数据处理",
    options: [{ value: "保留", label: "保留", description: "原有数据继续可用" }],
  };
  const html = renderAsk(request, false);
  assert.match(html, /数据处理/);
  assert.match(html, /原有数据继续可用/);
  assert.doesNotMatch(html, /<textarea/);
});

test("rpc-ui editor 使用 ZCode Ask 的多行输入", () => {
  const request: ZCodeElicitationRequest = {
    type: "elicitation_request",
    taskId: "session-1",
    traceId: "session-1",
    requestId: "ask-2",
    message: "补充说明",
    options: [],
  };
  const html = renderAsk(request, true);
  assert.match(html, /补充说明/);
  assert.match(html, /<textarea/);
});

test("敏感文本不走明文问答草稿，使用密码输入及取消入口", () => {
  const pending = {
    interactionId: "sensitive-1",
    kind: "userInput" as const,
    anchorRowId: null,
    createdAt: 1,
    payload: {
      kind: "userInput" as const,
      prompt: "密码",
      freeText: true,
      sensitive: true,
      answerMode: "text" as const,
      questions: [{ question: "密码", options: [] }],
    },
  };
  assert.equal(pendingUserInputToElicitationRequest("session-1", pending), null);
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4UserInputDialog, {
        model: pendingUserInputToViewModel(pending),
        onSubmit() {},
      }),
    ),
  );
  assert.match(html, /type="password"/u);
  assert.match(html, /取消/u);
  assert.doesNotMatch(html, /<textarea/u);
});

test("editor 完整初始值映射到多行临时编辑器，普通选项仍走富问答", () => {
  const pending = {
    interactionId: "editor-1",
    kind: "userInput" as const,
    anchorRowId: null,
    createdAt: 1,
    payload: {
      kind: "userInput" as const,
      prompt: "修改内容",
      freeText: true,
      answerMode: "text" as const,
      prefill: "  first\nsecond  ",
      questions: [{ question: "修改内容", options: [] }],
    },
  };
  assert.equal(pendingUserInputToElicitationRequest("session-1", pending), null);
  const model = pendingUserInputToViewModel(pending);
  assert.equal(model.prefill, pending.payload.prefill);
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(V4UserInputDialog, { model, onSubmit() {} }),
    ),
  );
  assert.match(html, /<textarea/u);
  assert.match(html, /  first\nsecond  <\/textarea>/u);
  const choice = pendingUserInputToElicitationRequest("session-1", {
    ...pending,
    payload: {
      kind: "userInput",
      prompt: "选择",
      freeText: false,
      answerMode: "option",
      questions: [{ question: "选择", options: [{ value: "yes", label: "Yes" }] }],
    },
  });
  assert.equal(choice?.questions?.[0]?.options[0]?.value, "yes");
});
