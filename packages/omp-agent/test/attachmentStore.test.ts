// attachmentStore sweeper 单测：staging 半程上传按上传 TTL 回收（原实现只清 committed）。
// TTL 来自 shared 常量不可注入，因此 sweep(now) 以时间参数注入 + mock Date 驱动 begin 时间戳。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { AttachmentStore } from "../src/app/attachmentStore.js";
import { ProtocolError } from "../src/app/errors.js";

const UPLOAD_TTL_MS = PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
const UNREFERENCED_TTL_MS = PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs;

function beginParams(uploadId: string) {
  return {
    connectionId: "conn",
    uploadId,
    sessionId: "session",
    fileName: "a.png",
    mime: "image/png",
    totalBytes: 10,
    totalChunks: 1,
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
  assert.throws(() => store.chunk({ uploadId: "stale", ...CHUNK }), /unknown upload/);
  // 未过期 staging 仍可继续上传。
  store.chunk({ uploadId: "fresh", ...CHUNK });
});

test("TTL 内的 staging 与已提交记录不被清理", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("young"));
  // 零字节直提路径直接进 committed，不依赖 begunAt。
  store.begin({ ...beginParams("empty"), totalBytes: 0, totalChunks: 0 });
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.sweep(Date.now());
  store.chunk({ uploadId: "young", ...CHUNK });
  store.commit({ uploadId: "young" });
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
  store.begin({ ...beginParams("slow"), totalBytes: 20, totalChunks: 2 });
  // 每隔 TTL-1s 推进一步：距 begin 的总时长接近 2×TTL，但每次成功 chunk 都刷新活跃时间。
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ uploadId: "slow", ...CHUNK, chunkIndex: 0 });
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ uploadId: "slow", ...CHUNK, chunkIndex: 1 });
  store.sweep(Date.now());
  // 上传仍在推进：未被回收，可正常 commit。
  store.commit({ uploadId: "slow" });
  assert.notEqual(store.lookup("omp-attachment://slow"), null);
});

test("滑动 TTL：停止 chunk 超过 TTL 后被回收", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new AttachmentStore();
  store.begin(beginParams("idle"));
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.chunk({ uploadId: "idle", ...CHUNK });
  t.mock.timers.tick(UPLOAD_TTL_MS - 1_000);
  store.sweep(Date.now());
  // 距 begin 已近 2×TTL，但距最后一次 chunk 不足 TTL：仍存活。
  store.chunk({ uploadId: "idle", ...CHUNK });
  t.mock.timers.tick(UPLOAD_TTL_MS + 1_000);
  store.sweep(Date.now());
  // 停止推进超过 TTL：按最后活跃时间回收，防泄漏语义保留。
  assert.throws(() => store.chunk({ uploadId: "idle", ...CHUNK }), /unknown upload/);
});

function isInvalidChunkParam(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === -32602;
}

test("越界 chunkIndex（<0 或 >=totalChunks）被拒绝", () => {
  const store = new AttachmentStore();
  store.begin({ ...beginParams("bounds"), totalBytes: 20, totalChunks: 2 });
  // 注意 chunkIndex 必须放在 ...CHUNK 之后，否则会被 CHUNK.chunkIndex=0 覆盖。
  assert.throws(
    () => store.chunk({ uploadId: "bounds", ...CHUNK, chunkIndex: -1 }),
    isInvalidChunkParam,
  );
  assert.throws(
    () => store.chunk({ uploadId: "bounds", ...CHUNK, chunkIndex: 2 }),
    isInvalidChunkParam,
  );
  // 被拒的分片不落库：仍可按合法 index 继续并完成上传。
  store.chunk({ uploadId: "bounds", ...CHUNK, chunkIndex: 0 });
  store.chunk({ uploadId: "bounds", ...CHUNK, chunkIndex: 1 });
  store.commit({ uploadId: "bounds" });
  assert.equal(store.bytesOf("omp-attachment://bounds")?.toString(), "01234567890123456789");
});

test("重发同片幂等替换：receivedBytes 不重复累加，commit 字节正确", () => {
  const store = new AttachmentStore();
  store.begin({ ...beginParams("dup"), totalBytes: 20, totalChunks: 2 });
  store.chunk({ uploadId: "dup", ...CHUNK, chunkIndex: 0 });
  store.chunk({ uploadId: "dup", ...CHUNK, chunkIndex: 1 });
  // 传输层重发 0 号片：替换同 index 字节而非重复累加。
  store.chunk({ uploadId: "dup", ...CHUNK, chunkIndex: 0 });
  // 若重复累加，receivedBytes=30 > totalBytes=20，commit 会被既有校验拒绝。
  store.commit({ uploadId: "dup" });
  assert.equal(store.bytesOf("omp-attachment://dup")?.toString(), "01234567890123456789");
});

test("缺 0 号片的 1..N 形态在 commit 处被既有校验拒绝", () => {
  const store = new AttachmentStore();
  store.begin({ ...beginParams("gap"), totalBytes: 30, totalChunks: 3 });
  store.chunk({ uploadId: "gap", ...CHUNK, chunkIndex: 1 });
  store.chunk({ uploadId: "gap", ...CHUNK, chunkIndex: 2 });
  // 试图用越界 index 补齐第 3 片：越界拒绝封死 1..N 凑满 size 的路径。
  assert.throws(
    () => store.chunk({ uploadId: "gap", ...CHUNK, chunkIndex: 3 }),
    isInvalidChunkParam,
  );
  // 只剩 2 片 ≠ totalChunks=3：既有 chunks.size 校验在 commit 处拒绝缺头形态。
  assert.throws(() => store.commit({ uploadId: "gap" }), /attachment upload incomplete/);
});
