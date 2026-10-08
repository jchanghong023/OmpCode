// attachmentStore sweeper 单测：staging 半程上传按上传 TTL 回收（原实现只清 committed）。
// TTL 来自 shared 常量不可注入，因此 sweep(now) 以时间参数注入 + mock Date 驱动 begin 时间戳。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { AttachmentStore } from "../src/app/attachmentStore.js";
import { ProtocolError } from "../src/app/errors.js";

const UPLOAD_TTL_MS = PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
const UNREFERENCED_TTL_MS = PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs;

function uploadParams(uploadId: string) {
  return { connectionId: "conn", sessionId: "session", uploadId };
}

function beginParams(uploadId: string, totalChunks = 1) {
  const bytes = Buffer.from("0123456789".repeat(totalChunks));
  return {
    ...uploadParams(uploadId),
    fileName: "a.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

const CHUNK = { chunkIndex: 0, dataBase64: Buffer.from("0123456789").toString("base64") };

test("超过上传 TTL 的 staging 被清理，未过期保留", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("stale"));
  t.mock.timers.tick(UPLOAD_TTL_MS + 1_000);
  store.begin(beginParams("fresh"));
  store.sweep(Date.now());
  // 过期 staging 已被回收：chunk 报 unknown upload。
  assert.throws(() => store.chunk({ ...uploadParams("stale"), ...CHUNK }), /unknown upload/);
  // 未过期 staging 仍可继续上传。
  store.chunk({ ...uploadParams("fresh"), ...CHUNK });
});

test("TTL 内的 staging 与已提交记录不被清理", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("young"));
  // 零字节也须经过 commit 验证空串摘要，不再由 begin 直接发布。
  store.begin(beginParams("empty", 0));
  assert.equal(store.bytesOf("omp-attachment://empty"), null);
  store.commit(uploadParams("empty"));
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.sweep(Date.now());
  store.chunk({ ...uploadParams("young"), ...CHUNK });
  store.commit(uploadParams("young"));
  t.mock.timers.tick(60_000);
  store.sweep(Date.now());
  assert.notEqual(store.lookup("omp-attachment://young"), null);
  assert.notEqual(store.lookup("omp-attachment://empty"), null);
  // committed 超过 unreferenced TTL 后仍按原逻辑回收。
  t.mock.timers.tick(UNREFERENCED_TTL_MS);
  store.sweep(Date.now());
  assert.equal(store.lookup("omp-attachment://young"), null);
});

test("滑动 TTL：持续 chunk（间隔 < TTL）跨越超过 TTL 的总时长不被回收", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("slow", 2));
  // 每隔 TTL-1s 推进一步：距 begin 的总时长接近 2×TTL，但每次成功 chunk 都刷新活跃时间。
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ ...uploadParams("slow"), ...CHUNK, chunkIndex: 0 });
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ ...uploadParams("slow"), ...CHUNK, chunkIndex: 1 });
  store.sweep(Date.now());
  // 上传仍在推进：未被回收，可正常 commit。
  store.commit(uploadParams("slow"));
  assert.notEqual(store.lookup("omp-attachment://slow"), null);
});

test("滑动 TTL：停止 chunk 超过 TTL 后被回收", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("idle"));
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ ...uploadParams("idle"), ...CHUNK });
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.sweep(Date.now());
  // 距 begin 已近 2×TTL，但距最后一次 chunk 不足 TTL：仍存活。
  store.chunk({ ...uploadParams("idle"), ...CHUNK });
  t.mock.timers.tick(UPLOAD_TTL_MS + 1_000);
  store.sweep(Date.now());
  // 停止推进超过 TTL：按最后活跃时间回收，防泄漏语义保留。
  assert.throws(() => store.chunk({ ...uploadParams("idle"), ...CHUNK }), /unknown upload/);
});

function isInvalidChunkParam(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === -32602;
}

test("越界 chunkIndex（<0 或 >=totalChunks）被拒绝", () => {
  const store = new AttachmentStore();
  store.begin(beginParams("bounds", 2));
  // 注意 chunkIndex 必须放在 ...CHUNK 之后，否则会被 CHUNK.chunkIndex=0 覆盖。
  assert.throws(
    () => store.chunk({ ...uploadParams("bounds"), ...CHUNK, chunkIndex: -1 }),
    isInvalidChunkParam,
  );
  assert.throws(
    () => store.chunk({ ...uploadParams("bounds"), ...CHUNK, chunkIndex: 2 }),
    isInvalidChunkParam,
  );
  // 被拒的分片不落库：仍可按合法 index 继续并完成上传。
  store.chunk({ ...uploadParams("bounds"), ...CHUNK, chunkIndex: 0 });
  store.chunk({ ...uploadParams("bounds"), ...CHUNK, chunkIndex: 1 });
  store.commit(uploadParams("bounds"));
  assert.equal(store.bytesOf("omp-attachment://bounds")?.toString(), "01234567890123456789");
});

test("重发同片幂等：receivedBytes 不重复累加，commit 字节正确", () => {
  const store = new AttachmentStore();
  store.begin(beginParams("dup", 2));
  store.chunk({ ...uploadParams("dup"), ...CHUNK, chunkIndex: 0 });
  store.chunk({ ...uploadParams("dup"), ...CHUNK, chunkIndex: 1 });
  // 传输层重发 0 号片：保持原字节而非重复累加。
  store.chunk({ ...uploadParams("dup"), ...CHUNK, chunkIndex: 0 });
  // 若重复累加，receivedBytes=30 > totalBytes=20，commit 会被既有校验拒绝。
  store.commit(uploadParams("dup"));
  assert.equal(store.bytesOf("omp-attachment://dup")?.toString(), "01234567890123456789");
});

test("缺 0 号片的 1..N 形态在 commit 处被既有校验拒绝", () => {
  const store = new AttachmentStore();
  store.begin(beginParams("gap", 3));
  store.chunk({ ...uploadParams("gap"), ...CHUNK, chunkIndex: 1 });
  store.chunk({ ...uploadParams("gap"), ...CHUNK, chunkIndex: 2 });
  // 试图用越界 index 补齐第 3 片：越界拒绝封死 1..N 凑满 size 的路径。
  assert.throws(
    () => store.chunk({ ...uploadParams("gap"), ...CHUNK, chunkIndex: 3 }),
    isInvalidChunkParam,
  );
  // 只剩 2 片 ≠ totalChunks=3：既有 chunks.size 校验在 commit 处拒绝缺头形态。
  assert.throws(() => store.commit(uploadParams("gap")), /attachment upload incomplete/);
});

test("F008：完整分片仍必须精确匹配声明字节数与 SHA256，失败不发布 ref", () => {
  for (const [uploadId, totalBytes, expectedBytes, receivedBytes] of [
    ["short", 2, "ab", "a"],
    ["long", 1, "a", "ab"],
    ["wrong-hash", 1, "b", "a"],
  ] as const) {
    const store = new AttachmentStore();
    const checksum = `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`;
    store.begin({ ...beginParams(uploadId), totalBytes, checksum });
    store.chunk({
      ...uploadParams(uploadId),
      chunkIndex: 0,
      dataBase64: Buffer.from(receivedBytes).toString("base64"),
    });
    assert.throws(() => store.commit(uploadParams(uploadId)), isInvalidChunkParam);
    assert.equal(store.lookup(`omp-attachment://${uploadId}`), null);
    assert.equal(store.bytesOf(`omp-attachment://${uploadId}`), null);
    store.abort(uploadParams(uploadId));
    assert.throws(() => store.commit(uploadParams(uploadId)), /unknown upload/);
  }
});

test("F008：零字节须零分片且 commit 验证正确空串摘要", () => {
  const store = new AttachmentStore();
  assert.throws(
    () => store.begin({ ...beginParams("invalid-empty", 0), totalChunks: 1 }),
    isInvalidChunkParam,
  );
  assert.throws(
    () => store.begin({ ...beginParams("invalid-nonempty"), totalChunks: 0 }),
    isInvalidChunkParam,
  );
  store.begin({ ...beginParams("bad-empty", 0), checksum: `sha256:${"0".repeat(64)}` });
  assert.throws(() => store.commit(uploadParams("bad-empty")), /checksum mismatch/);
  assert.equal(store.bytesOf("omp-attachment://bad-empty"), null);
  store.begin(beginParams("empty", 0));
  assert.equal(store.lookup("omp-attachment://empty"), null);
  assert.deepEqual(store.commit(uploadParams("empty")), { ref: "omp-attachment://empty" });
  assert.deepEqual(store.bytesOf("omp-attachment://empty"), Buffer.alloc(0));
});

test("F008：固定归属及内容声明，重复 begin/chunk/commit 不改变已提交 ref", () => {
  const store = new AttachmentStore();
  const params = beginParams("owned", 2);
  store.begin(params);
  store.chunk({ ...uploadParams("owned"), ...CHUNK, chunkIndex: 1 });
  assert.equal(store.begin(params).nextChunkIndex, 0);
  store.chunk({ ...uploadParams("owned"), ...CHUNK });
  assert.equal(store.begin(params).nextChunkIndex, 2);
  assert.throws(
    () => store.begin({ ...params, checksum: `sha256:${"0".repeat(64)}` }),
    /declaration conflict/,
  );
  assert.throws(
    () =>
      store.chunk({
        ...uploadParams("owned"),
        chunkIndex: 0,
        dataBase64: Buffer.from("different!").toString("base64"),
      }),
    /chunk conflict/,
  );
  for (const foreignOwner of [
    { ...uploadParams("owned"), connectionId: "other-connection" },
    { ...uploadParams("owned"), sessionId: "other-session" },
  ]) {
    assert.throws(() => store.begin({ ...params, ...foreignOwner }), /owner mismatch/);
    assert.throws(() => store.chunk({ ...foreignOwner, ...CHUNK }), /owner mismatch/);
    assert.throws(() => store.commit(foreignOwner), /owner mismatch/);
    assert.throws(() => store.abort(foreignOwner), /owner mismatch/);
  }
  const committed = store.commit(uploadParams("owned"));
  assert.deepEqual(store.commit(uploadParams("owned")), committed);
  assert.equal(store.begin(params).state, "committed");
  store.chunk({ ...uploadParams("owned"), ...CHUNK });
  store.abort(uploadParams("owned"));
  assert.deepEqual(store.bytesOf(committed.ref), Buffer.from("01234567890123456789"));
  assert.throws(() => store.begin({ ...params, fileName: "other.png" }), /declaration conflict/);
  assert.throws(
    () => store.commit({ ...uploadParams("owned"), sessionId: "other-session" }),
    /owner mismatch/,
  );
  assert.deepEqual(store.bytesOf(committed.ref), Buffer.from("01234567890123456789"));
});

test("F008：乱序二进制分片按 chunkIndex 验证原字节摘要，模型读取保持原顺序", () => {
  const store = new AttachmentStore();
  const bytes = Buffer.from([0, 255, 128, 1, 2]);
  const owner = uploadParams("out-of-order");
  store.begin({
    ...beginParams(owner.uploadId, 2),
    totalBytes: bytes.length,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  store.chunk({ ...owner, chunkIndex: 1, dataBase64: bytes.subarray(2).toString("base64") });
  store.chunk({ ...owner, chunkIndex: 0, dataBase64: bytes.subarray(0, 2).toString("base64") });
  const { ref } = store.commit(owner);
  assert.deepEqual(store.bytesOf(ref), bytes);
  assert.deepEqual(store.ompImagesOf(ref), [
    { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
  ]);
});
