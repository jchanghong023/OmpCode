import assert from "node:assert/strict";
import test from "node:test";
import { resolveReasoningStreamingSummary } from "../src/components/ai-elements/reasoningSummary.js";
import { createCodeViewerFile } from "../src/components/ui/codeViewerFile.js";

function referenceSummary(text: string): string | null {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length > 0) return line;
  }
  return null;
}

test("折叠思考保留最后有效行语义，兼容空行、CRLF与Unicode空白", () => {
  for (const text of [
    "",
    " \t\r\n \u00a0\n",
    "首行",
    "首行\n末行",
    "首行\r末行\r",
    "首行\r\n  最新内容 \t\r\n\r\n  ",
    "首行\r\r\n\n末行\r\n\t",
    "首行\n\u3000最新中文🙂\u00a0\n",
  ]) {
    assert.equal(resolveReasoningStreamingSummary(text)?.text ?? null, referenceSummary(text));
  }
});

test("同一思考行追加保持滚动身份，新行和完整替换显示最新内容", () => {
  const first = resolveReasoningStreamingSummary("旧行\r\n 新行");
  const appended = resolveReasoningStreamingSummary("旧行\r\n 新行继续追加\r\n\t");
  assert.equal(appended?.key, first?.key);
  assert.equal(appended?.text, "新行继续追加");
  assert.notEqual(
    resolveReasoningStreamingSummary("旧行\r\n 新行继续追加\r\n下一行")?.key,
    first?.key,
  );
  assert.equal(resolveReasoningStreamingSummary("完全替换")?.text, "完全替换");
});

test("长思考的摘要查找仅访问尾行，不随历史前缀长度扫描", () => {
  const tail = " 最新尾行 \r\n\t\r\n";
  const scanCounts: number[] = [];
  for (const lineCount of [10, 100_000]) {
    const text = "过去思考内容\r\n".repeat(lineCount) + tail;
    let visits = 0;
    const instrumented = {
      length: text.length,
      charCodeAt(index: number) {
        visits += 1;
        return text.charCodeAt(index);
      },
      slice(start: number, end: number) {
        return text.slice(start, end);
      },
    } as unknown as string;
    assert.equal(resolveReasoningStreamingSummary(instrumented)?.text, "最新尾行");
    scanCounts.push(visits);
  }
  assert.equal(scanCounts[0], scanCounts[1]);
  assert.ok(scanCounts[0]! <= 2 * tail.length);
});

test("流式代码不扫描全文生成缓存键，保留最新完整内容和语言元数据", () => {
  const text = "const value = 1;\n".repeat(100_000);
  let visits = 0;
  const instrumented = {
    length: text.length,
    charCodeAt(index: number) {
      visits += 1;
      return text.charCodeAt(index);
    },
  } as unknown as string;
  const file = createCodeViewerFile({
    code: instrumented,
    enableSyntaxHighlighting: false,
    language: "typescript",
    theme: "github-dark",
  });
  assert.equal(visits, 0);
  assert.equal(file.contents, instrumented);
  assert.equal(file.lang, "text");
  assert.equal(file.name, "preview.typescript");
  assert.equal(file.cacheKey, undefined);
  const replaced = createCodeViewerFile({
    code: "const value = 2;",
    enableSyntaxHighlighting: false,
    language: "javascript",
  });
  assert.equal(replaced.contents, "const value = 2;");
  assert.equal(replaced.name, "preview.javascript");
});

test("完成态高亮缓存区分同长度内容、语言和主题，相同输入仍复用缓存键", () => {
  const params = {
    code: "const value = 1;",
    enableSyntaxHighlighting: true,
    language: "typescript",
    theme: "github-dark" as const,
  };
  const first = createCodeViewerFile(params);
  assert.equal(first.contents, params.code);
  assert.equal(first.lang, "typescript");
  assert.ok(first.cacheKey);
  assert.equal(createCodeViewerFile(params).cacheKey, first.cacheKey);
  for (const update of [
    { code: "const value = 2;" },
    { language: "javascript" },
    { theme: "github-light" as const },
  ]) {
    assert.notEqual(createCodeViewerFile({ ...params, ...update }).cacheKey, first.cacheKey);
  }
});
