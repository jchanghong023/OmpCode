import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeChatComposerAttachment } from "../src/lib/chatAttachments.js";

// F40：超长文本附件的截断标记不得在底层序列化边界硬编码中文，
// 必须由调用方按 locale 传入（与 OversizedInline* 结构化错误同一边界约定）。
const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64 * 1024;

function buildTextFile(text: string): File {
  return new File([text], "notes.txt", { type: "text/plain" });
}

test("未超长文本原样返回，不追加截断标记", async () => {
  const attachment = {
    id: "a1",
    file: buildTextFile("hello"),
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  };
  const serialized = await serializeChatComposerAttachment(attachment, {
    truncatedTextMarker: "内容过长，已截断",
  });
  assert.equal(serialized.kind, "file");
  assert.equal(serialized.kind === "file" && serialized.textContent, "hello");
});

test("超长文本截断到阈值并追加调用方传入的本地化标记", async () => {
  const text = "a".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS + 100);
  const attachment = {
    id: "a2",
    file: buildTextFile(text),
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: text.length,
  };
  const serialized = await serializeChatComposerAttachment(attachment, {
    truncatedTextMarker: "Content truncated due to length",
  });
  assert.ok(serialized.kind === "file");
  if (serialized.kind !== "file") return;
  assert.equal(
    serialized.textContent,
    `${"a".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS)}\n\nContent truncated due to length`,
  );
  assert.ok(!serialized.textContent.includes("已截断"));
});

test("未传截断标记时只截断、不追加任何硬编码文案", async () => {
  const text = "b".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS + 100);
  const attachment = {
    id: "a3",
    file: buildTextFile(text),
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: text.length,
  };
  const serialized = await serializeChatComposerAttachment(attachment);
  assert.ok(serialized.kind === "file");
  if (serialized.kind !== "file") return;
  assert.equal(serialized.textContent, "b".repeat(INLINE_TEXT_ATTACHMENT_MAX_CHARS));
});
