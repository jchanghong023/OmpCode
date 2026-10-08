import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolveReasoningStreamingSummary } from "../src/components/ai-elements/reasoningSummary.js";
import { createCodeViewerFile } from "../src/components/ui/codeViewerFile.js";

// 同一合成累计文本对照旧实现与当前入口；不读取会话、不调用模型。
function previousSummary(text: string) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length > 0) return line;
  }
  return null;
}

function previousFile(code: string) {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }
  return {
    contents: code,
    cacheKey: `github-dark:preview.typescript:text:${code.length}:${(hash >>> 0).toString(36)}`,
  };
}

const sample = "过去思考内容与代码行\r\n".repeat(50_000);
const frames = Array.from({ length: 30 }, (_, index) => sample + "最新尾行" + "增量".repeat(index));
const time = (run: () => void) => {
  const start = performance.now();
  run();
  return Number((performance.now() - start).toFixed(3));
};
// 先验证所有对照数据的可见内容；测量仅代表当前 Node 合成场景。
for (const text of frames) {
  assert.equal(resolveReasoningStreamingSummary(text)?.text ?? null, previousSummary(text));
  assert.equal(
    createCodeViewerFile({ code: text, enableSyntaxHighlighting: false, language: "typescript" })
      .contents,
    previousFile(text).contents,
  );
}
const beforeSummaryMs = time(() => frames.forEach(previousSummary));
const afterSummaryMs = time(() => frames.forEach(resolveReasoningStreamingSummary));
const beforeCodeMs = time(() => frames.forEach(previousFile));
const afterCodeMs = time(() => {
  for (const code of frames) {
    createCodeViewerFile({ code, enableSyntaxHighlighting: false, language: "typescript" });
  }
});
let afterSummaryCharacterVisits = 0;
let afterCodeHashCharacterVisits = 0;
for (const text of frames) {
  const instrumented = {
    length: text.length,
    charCodeAt(index: number) {
      afterSummaryCharacterVisits += 1;
      return text.charCodeAt(index);
    },
    slice(start: number, end: number) {
      return text.slice(start, end);
    },
  } as unknown as string;
  resolveReasoningStreamingSummary(instrumented);
  instrumented.charCodeAt = () => {
    afterCodeHashCharacterVisits += 1;
    return 0;
  };
  createCodeViewerFile({
    code: instrumented,
    enableSyntaxHighlighting: false,
    language: "typescript",
  });
}
const totalSourceCharacters = frames.reduce((total, text) => total + text.length, 0);
console.log(
  JSON.stringify({
    node: process.version,
    frames: frames.length,
    sampleCharacters: sample.length,
    summary: {
      beforeFullSourceCharactersPassedToReplaceAndSplit: 2 * totalSourceCharacters,
      afterCharacterVisits: afterSummaryCharacterVisits,
      beforeMs: beforeSummaryMs,
      afterMs: afterSummaryMs,
    },
    streamingCode: {
      beforeHashCharacterVisits: totalSourceCharacters,
      afterHashCharacterVisits: afterCodeHashCharacterVisits,
      beforeMs: beforeCodeMs,
      afterMs: afterCodeMs,
    },
  }),
);
