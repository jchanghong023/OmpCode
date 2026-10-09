import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FallbackToolCallBlock } from "../src/ToolCallBlocks/renderers/fallback.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

function render(output: string, input: unknown = {}, error?: string) {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      toolCall: {
        toolId: "fixture-wait",
        toolName: "wait",
        kind: "wait",
        status: error ? "failed" : "completed",
        input,
        output,
        error,
        raw: { diagnostic: "raw-only-marker" },
      },
      childToolCalls: [],
    },
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: true,
      showOutput: true,
      showKind: true,
    },
    workspacePath: "D:/fixture",
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "已执行",
    childToolList: null,
    forceOpen: true,
    errorText: error,
  };
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, null, createElement(FallbackToolCallBlock, context)),
    ),
  );
}

test("空参数 wait 只显示一份可读结果，调试数据默认折叠", () => {
  const html = render("returned-once");
  assert.equal(html.split("returned-once").length - 1, 1);
  assert.doesNotMatch(html, /调用参数|raw-only-marker|<p[^>]*>wait<\/p>/);
  assert.match(html, /查看原始数据/);
  assert.match(html, /data-state="closed"/);
  assert.match(html, /whitespace-pre-wrap break-words/);
});

test("非空参数和失败信息仍保留", () => {
  const html = render("should-not-display", { id: "task-123" }, "wait-failed");
  assert.match(html, /调用参数/);
  // 代码组件在浏览器 effect 中挂载内容；SSR 验证参数入口和 JSON 代码容器保留。
  assert.match(html, /data-language="json"/);
  assert.match(html, /wait-failed/);
  assert.doesNotMatch(html, /should-not-display|raw-only-marker/);
});

test("Markdown 工具结果呈现标题且保留代码原文", () => {
  const html = render(
    "## Completed (1)\n\nhello\n\n```text\n<task-result>hello</task-result>\n```",
  );
  assert.match(html, /<h2[^>]*>Completed \(1\)<\/h2>/);
  assert.match(html, /hello/);
  assert.doesNotMatch(html, /raw-only-marker/);
});
