import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";

test("原生技能调用复用上游技能 chip，保留句中上下文和参数空白", () => {
  assert.deepEqual(parseMentionMarkdown("请用 /skill:jch-benchmark-cpu  参数\n后续正文"), [
    { type: "text", text: "请用 " },
    { type: "skill", label: "jch-benchmark-cpu" },
    { type: "text", text: "  参数\n后续正文" },
  ]);
});

test("不完整技能 token、路径和嵌入单词中的 token 仍保持普通文本", () => {
  for (const text of [
    "/skill:",
    "/skill:reviewer/path",
    "prefix/skill:reviewer",
    "/skill:reviewer:other",
  ]) {
    assert.deepEqual(parseMentionMarkdown(text), [{ type: "text", text }]);
  }
});
