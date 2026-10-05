import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentStore } from "../src/app/attachmentStore.js";
import { prepareOmpAttachmentInput } from "../src/app/ompAttachmentInput.js";

function upload(store: AttachmentStore, name: string, mime: string, bytes: Buffer) {
  const uploadId = `test-${name}`;
  store.begin({
    connectionId: "test",
    uploadId,
    sessionId: "session",
    fileName: name,
    mime,
    totalBytes: bytes.length,
    totalChunks: 1,
  });
  store.chunk({ uploadId, chunkIndex: 0, dataBase64: bytes.toString("base64") });
  const { ref } = store.commit({ uploadId });
  return { ref, fileName: name, mime, bytes: bytes.length };
}

test("UTF-8 文本附件进入 omp prompt，图片仍为 image content", () => {
  const store = new AttachmentStore();
  const text = upload(store, "readme.md", "text/markdown", Buffer.from("hello omp", "utf8"));
  const image = upload(store, "image.png", "image/png", Buffer.from([1, 2, 3]));
  const result = prepareOmpAttachmentInput("请总结", [text, image], store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /readme\.md/);
  assert.match(result.text, /hello omp/);
  assert.deepEqual(result.images, [{ type: "image", data: "AQID", mimeType: "image/png" }]);
});

test("不支持的 PDF 与缺失引用明确拒绝，不静默跳过", () => {
  const store = new AttachmentStore();
  const pdf = upload(store, "report.pdf", "application/pdf", Buffer.from("%PDF-test"));
  assert.deepEqual(prepareOmpAttachmentInput("总结", [pdf], store), {
    ok: false,
    error: "report.pdf: unsupported attachment type application/pdf",
  });
  assert.deepEqual(prepareOmpAttachmentInput("总结", [{ ...pdf, ref: "missing" }], store), {
    ok: false,
    error: "attachment reference missing",
  });
});

test("无效 UTF-8 或超限文本明确拒绝", () => {
  const store = new AttachmentStore();
  const invalid = upload(store, "bad.txt", "text/plain", Buffer.from([0xff]));
  assert.deepEqual(prepareOmpAttachmentInput("读", [invalid], store), {
    ok: false,
    error: "bad.txt: invalid UTF-8 text",
  });
  const huge = upload(store, "huge.txt", "text/plain", Buffer.alloc(256 * 1024 + 1, 65));
  assert.deepEqual(prepareOmpAttachmentInput("读", [huge], store), {
    ok: false,
    error: "huge.txt: text attachment exceeds 256 KiB",
  });
});

// A6：斜杠+文本附件的拒绝发生在 dispatch 层（能拿到 projectMode）；本层的正常消息拼接
// 行为保持不变——斜杠输入的拼接也不在此拦截，钉住守卫不落在错误层。
// 优化项（S5-8）：拼接顺序对齐 omp `${textPrefix}${message}`（附件上下文先于用户消息）。
test("斜杠输入的文本附件仍照常拼接（守卫在 dispatch 层，A6），且附件块前置", () => {
  const store = new AttachmentStore();
  const text = upload(store, "notes.md", "text/markdown", Buffer.from("内容", "utf8"));
  const result = prepareOmpAttachmentInput("/compact", [text], store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.text,
    '<attached_file name="notes.md" mime="text/markdown">\n内容\n</attached_file>\n\n/compact',
  );
  assert.deepEqual(result.images, []);
});

// S5-5：omp rpc-fork-attachments MAX_ATTACHMENTS=8，超限整条 prompt 被拒（attachment_limit）；
// 本地预检抛明确错误，不发必败请求。
test("附件总数（image+text 合计）超过 8 明确拒绝", () => {
  const store = new AttachmentStore();
  const refs = Array.from({ length: 9 }, (_value, index) =>
    upload(store, `note-${index}.txt`, "text/plain", Buffer.from(`content-${index}`, "utf8")),
  );
  assert.deepEqual(prepareOmpAttachmentInput("总结", refs, store), {
    ok: false,
    error: "too many attachments: 9 (limit 8)",
  });
  // 恰好 8 个不拒。
  assert.equal(prepareOmpAttachmentInput("总结", refs.slice(0, 8), store).ok, true);
});
