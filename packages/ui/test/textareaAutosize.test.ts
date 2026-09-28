import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ElicitationDialog } from "../src/ElicitationDialog.js";
import { resizeTextareaToContent, supportsCssFieldSizing } from "../src/lib/textareaAutosize.js";

test("field-sizing 能力检测可判定且稳定（按进程缓存）", () => {
  assert.equal(typeof supportsCssFieldSizing(), "boolean");
  assert.equal(supportsCssFieldSizing(), supportsCssFieldSizing());
});

test("JS 自适应把高度复位为内容高度（Chromium 120 无 field-sizing 时的兜底行为）", () => {
  const element = {
    style: { height: "64px" },
    scrollHeight: 132,
  } as unknown as HTMLTextAreaElement;
  resizeTextareaToContent(element);
  // 先复位为 auto 再按 scrollHeight 赋值，避免旧高度参与测量。
  assert.equal(element.style.height, "132px");
});

test("多行 elicitation 输入在静态渲染下仍保留 field-sizing 类（原生优先、JS 兜底）", () => {
  const request = {
    type: "elicitation_request",
    taskId: "session-css",
    traceId: "trace-css",
    requestId: "ask-css",
    message: "补充说明",
    options: [],
  };
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ElicitationDialog, { request, allowCustomInput: true, onRespond() {} }),
    ),
  );
  assert.match(html, /<textarea/u);
  assert.match(html, /field-sizing-content/u);
});
