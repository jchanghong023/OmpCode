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

function renderAsk(
  request: ZCodeElicitationRequest,
  allowCustomInput: boolean,
  initialLocale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale,
      children: createElement(ElicitationDialog, { request, allowCustomInput, onRespond() {} }),
    }),
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

test("rpc-ui 推荐提示展示在对应选项且不会预选答案", () => {
  const question = {
    question: "选择实施方式",
    header: "实施方式",
    recommended: 1,
    options: [
      { value: "replace", label: "替换实现" },
      { value: "reuse", label: "复用实现", preview: "保持现有调用路径" },
    ],
  };
  const html = renderAsk(
    {
      type: "elicitation_request",
      taskId: "session-1",
      traceId: "session-1",
      requestId: "ask-recommended",
      message: question.question,
      options: question.options,
      questions: [question],
    },
    false,
  );
  const optionButtons = html.match(/<button\b[^>]*role="option"[^>]*>[\s\S]*?<\/button>/gu);
  assert.equal(optionButtons?.length, 2);
  assert.doesNotMatch(optionButtons![0]!, /推荐/u);
  assert.match(optionButtons![1]!, /复用实现[\s\S]*推荐/u);
  assert.doesNotMatch(html, /aria-selected="true"|aria-checked="true"/u);
});

test("rpc-ui 英文多选的第一个推荐选项只显示提示且保留自定义入口", () => {
  const html = renderAsk(
    {
      type: "elicitation_request",
      taskId: "session-1",
      traceId: "session-1",
      requestId: "ask-recommended-multi",
      message: "Choose storage",
      options: [],
      questions: [
        {
          question: "Choose storage",
          header: "Storage",
          multiSelect: true,
          recommended: 0,
          options: [
            { value: "postgres", label: "Postgres", preview: "SELECT 1;" },
            { value: "sqlite", label: "SQLite" },
          ],
        },
      ],
    },
    true,
    "en-US",
  );
  const optionButtons = html.match(/<button\b[^>]*role="checkbox"[^>]*>[\s\S]*?<\/button>/gu);
  assert.match(html, /role="group" aria-label="Choose storage"/u);
  assert.equal(optionButtons?.length, 2);
  assert.match(optionButtons![0]!, /Postgres[\s\S]*Recommended/u);
  assert.doesNotMatch(optionButtons![1]!, /Recommended/u);
  assert.doesNotMatch(html, /aria-selected="true"|aria-checked="true"/u);
  assert.match(html, /<textarea/u);
  assert.match(html, />Submit</u);
  assert.match(html, />Dismiss</u);
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
      questions: [{ question: "密码", header: "密码", options: [] }],
    },
  };
  assert.equal(pendingUserInputToElicitationRequest("session-1", pending), null);
  const html = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(V4UserInputDialog, {
        model: pendingUserInputToViewModel(pending),
        onSubmit() {},
      }),
    }),
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
      questions: [{ question: "修改内容", header: "修改内容", options: [] }],
    },
  };
  assert.equal(pendingUserInputToElicitationRequest("session-1", pending), null);
  const model = pendingUserInputToViewModel(pending);
  assert.equal(model.prefill, pending.payload.prefill);
  const html = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(V4UserInputDialog, { model, onSubmit() {} }),
    }),
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
      questions: [{ question: "选择", header: "选择", options: [{ value: "yes", label: "Yes" }] }],
    },
  });
  assert.equal(choice?.questions?.[0]?.options[0]?.value, "yes");
});
