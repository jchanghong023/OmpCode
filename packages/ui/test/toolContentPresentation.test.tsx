import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ToolInput, ToolOutput } from "../src/components/ai-elements/tool.js";
import { hasToolInput, isJsonToolText } from "../src/lib/toolContentPresentation.js";

function render(element: React.ReactNode, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: locale }, element));
}

test("共用参数区隐藏空值，MCP 可复用同一规则", () => {
  for (const input of [undefined, null, "", " \n ", {}, []]) {
    assert.equal(hasToolInput(input), false);
    assert.equal(render(createElement(ToolInput, { input })), "");
  }
  for (const input of [0, false, "hello", { id: 1 }, [1]]) {
    assert.equal(hasToolInput(input), true);
    assert.match(render(createElement(ToolInput, { input })), /调用参数/);
  }
});

test("零和布尔结果不丢失，空结果不占位", () => {
  for (const output of [0, false, true]) {
    const html = render(createElement(ToolOutput, { output, errorText: undefined }));
    assert.match(html, /结果/);
    assert.ok(html.includes(`>${String(output)}</div>`));
  }
  for (const output of [undefined, null, ""]) {
    assert.equal(render(createElement(ToolOutput, { output, errorText: undefined })), "");
  }
});

test("普通文本与畸形 JSON 自动折行，合法对象与数组仍显示为 JSON", () => {
  for (const output of ["first\nlast", "{broken", "[warning] retry"]) {
    assert.equal(isJsonToolText(output), false);
    const html = render(createElement(ToolOutput, { output, errorText: undefined }));
    assert.match(html, /whitespace-pre-wrap break-words/);
    assert.doesNotMatch(html, /data-language="json"/);
  }
  for (const output of ['{"value":0}', "[false]", { value: 0 }, [false]]) {
    if (typeof output === "string") assert.equal(isJsonToolText(output), true);
    assert.match(
      render(createElement(ToolOutput, { output, errorText: undefined })),
      /data-language="json"/,
    );
  }
});

test("错误优先，标签随语言显示", () => {
  const output = createElement(ToolOutput, { output: "hidden-result", errorText: "visible-error" });
  const zh = render(output);
  assert.match(zh, /错误/);
  assert.match(zh, /visible-error/);
  assert.doesNotMatch(zh, /hidden-result/);
  assert.match(render(output, "en-US"), />Error</);
  assert.match(render(createElement(ToolInput, { input: { id: 1 } }), "en-US"), />Parameters</);
});
