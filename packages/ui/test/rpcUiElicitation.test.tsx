import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeElicitationRequest } from "@zcode/shared";
import { ElicitationDialog } from "../src/ElicitationDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

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
