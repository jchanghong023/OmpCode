// OmpFrameAssembler（rpc_chunk v2 无损分片重组）纯 UT：钉住当前重组语义（正常序/乱序/
// 缺首片/重复/坏 base64/坏 UTF-8/字节总和不符/坏 JSON/超限/交错/单片直通/范围校验/
// 上限更新/中断）。协议进程与会话验收使用共享真实 OMP 启动器，不在此伪造核心。
// 修复 S3-4 后分片形状与 omp 发送端（rpc-frame.ts）一致：先切 UTF-8 字节再逐片 base64
//（各片自带 padding），重组完成校验实收字节总和、严格 UTF-8 解码。

import assert from "node:assert/strict";
import { test } from "node:test";
import { OmpFrameAssembler } from "../src/domain/frameAssembler.js";
import type { OmpRpcChunkFrame } from "../src/domain/ompFrames.js";

function chunk(
  chunkId: string,
  index: number,
  count: number,
  byteLength: number,
  data: string,
): OmpRpcChunkFrame {
  return { type: "rpc_chunk", chunkId, index, count, byteLength, data };
}

/** 把任意 UTF-8 文本按 omp 编码形状切成 count 片（先切字节再逐片 base64）。 */
function fragmentsOfText(text: string, count: number, chunkId: string): OmpRpcChunkFrame[] {
  const bytes = Buffer.from(text, "utf8");
  const per = Math.ceil(bytes.byteLength / count);
  return Array.from({ length: count }, (_, index) =>
    chunk(
      chunkId,
      index,
      count,
      bytes.byteLength,
      bytes.subarray(index * per, (index + 1) * per).toString("base64"),
    ),
  );
}

/** 把逻辑帧 JSON 按 omp 编码形状切成 count 片（byteLength = 解码后总字节数）。 */
function fragments(frame: unknown, count: number, chunkId: string): OmpRpcChunkFrame[] {
  return fragmentsOfText(JSON.stringify(frame), count, chunkId);
}

test("正常序多片重组：按 index 归位，末片到达即 assembled", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(assembler.push(fragments({ type: "x" }, 2, "seq-a")[0]!), { kind: "pending" });
  const result = assembler.push(fragments({ type: "x" }, 2, "seq-a")[1]!);
  assert.deepEqual(result, { kind: "assembled", frame: { type: "x" } });
});

test("乱序接受（当前实现语义）：非首片乱序到达仍按 index 归位重组", () => {
  const assembler = new OmpFrameAssembler();
  const parts = fragments({ a: 1 }, 3, "seq-o");
  assert.deepEqual(assembler.push(parts[0]!), { kind: "pending" });
  assert.deepEqual(assembler.push(parts[2]!), { kind: "pending" });
  assert.deepEqual(assembler.push(parts[1]!), { kind: "assembled", frame: { a: 1 } });
});

test("缺首片拒绝：无挂起序列时首达分片 index≠0 整体拒绝", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(assembler.push(chunk("seq-m", 1, 2, 12, "IjoieCJ9")), {
    kind: "rejected",
    reason: "rpc_chunk sequence missing initial fragment",
  });
});

test("重复分片整体拒绝：后续片不得复用已拒序列", () => {
  const assembler = new OmpFrameAssembler();
  const parts = fragments({ type: "x" }, 2, "seq-d");
  assert.deepEqual(assembler.push(parts[0]!), { kind: "pending" });
  assert.deepEqual(assembler.push(parts[0]!), {
    kind: "rejected",
    reason: "duplicate rpc_chunk fragment",
  });
  assert.deepEqual(assembler.push(parts[1]!), {
    kind: "rejected",
    reason: "rpc_chunk sequence missing initial fragment",
  });
});

test("坏 base64：分片载荷非法即拒并丢弃挂起序列（S3-4 逐片严格校验）", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(assembler.push(chunk("seq-b64", 0, 2, 8, "!!!!")), {
    kind: "rejected",
    reason: "rpc_chunk payload is not valid base64",
  });
  // 序列已整体丢弃：同序列后续分片按缺首片拒绝，不再留下永远无法完成的半挂起序列。
  assert.deepEqual(assembler.push(chunk("seq-b64", 1, 2, 8, "e30=")), {
    kind: "rejected",
    reason: "rpc_chunk sequence missing initial fragment",
  });
});

test("坏 JSON：base64 合法但解码后非 JSON 拒绝", () => {
  const assembler = new OmpFrameAssembler();
  const parts = fragmentsOfText("not-json", 2, "seq-json");
  assert.deepEqual(assembler.push(parts[0]!), { kind: "pending" });
  assert.deepEqual(assembler.push(parts[1]!), {
    kind: "rejected",
    reason: "reassembled frame is not valid JSON",
  });
});

test("坏 UTF-8：字节合法但含坏 UTF-8 序列拒绝，不以 U+FFFD 照常解析（S3-4①）", () => {
  const assembler = new OmpFrameAssembler();
  // `{"a":"<0xFF>"}`：0xFF 不是合法 UTF-8 序列；非 fatal 解码会替换成 U+FFFD 后仍可 JSON.parse。
  const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const per = Math.ceil(bytes.byteLength / 2);
  const first = assembler.push(
    chunk("seq-utf8", 0, 2, bytes.byteLength, bytes.subarray(0, per).toString("base64")),
  );
  assert.deepEqual(first, { kind: "pending" });
  assert.deepEqual(
    assembler.push(
      chunk("seq-utf8", 1, 2, bytes.byteLength, bytes.subarray(per).toString("base64")),
    ),
    { kind: "rejected", reason: "reassembled frame is not valid UTF-8" },
  );
});

test("字节总和与声明不符拒绝：实收分片字节总和 ≠ 声明 byteLength（S3-4②）", () => {
  const assembler = new OmpFrameAssembler();
  const bytes = Buffer.from('{"type":"x"}', "utf8");
  assembler.push(
    chunk("seq-len", 0, 2, bytes.byteLength + 3, bytes.subarray(0, 6).toString("base64")),
  );
  assert.deepEqual(
    assembler.push(
      chunk("seq-len", 1, 2, bytes.byteLength + 3, bytes.subarray(6).toString("base64")),
    ),
    {
      kind: "rejected",
      reason: "reassembled fragment bytes do not match declared byteLength",
    },
  );
});

test("omp 真实编码形状不受影响：整块片 base64 自带 padding（>256KiB 双片）照常重组", () => {
  const assembler = new OmpFrameAssembler();
  // omp 发送端按 256KiB 字节切块后逐片 toString("base64")：整块片（262144 ≡ 1 mod 3）
  // 以 "==" 结尾。旧的「拼合 base64 串再解码」会在串中部遇到 padding 而误拒。
  const filler = "x".repeat(300_000);
  const frame = { type: "big", filler };
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  const cut = 256 * 1024;
  assert.equal(
    bytes.subarray(0, cut).toString("base64").endsWith("=="),
    true,
    "前置条件：首片为带 padding 的整块片",
  );
  assert.deepEqual(
    assembler.push(
      chunk("seq-pad", 0, 2, bytes.byteLength, bytes.subarray(0, cut).toString("base64")),
    ),
    { kind: "pending" },
  );
  const result = assembler.push(
    chunk("seq-pad", 1, 2, bytes.byteLength, bytes.subarray(cut).toString("base64")),
  );
  assert.deepEqual(result, { kind: "assembled", frame });
});

test("超限拒绝：声明 byteLength 超过构造上限即拒；默认上限（64MiB）不触发", () => {
  const limited = new OmpFrameAssembler(64);
  assert.deepEqual(
    limited.push(chunk("seq-big", 0, 1, 65, Buffer.from("{}", "utf8").toString("base64"))),
    {
      kind: "rejected",
      reason: "reassembled frame exceeds advertised limit",
    },
  );
  const unlimited = new OmpFrameAssembler();
  // 65 字节真实载荷（尾随空格仍是合法 JSON），声明与实收一致才可组装。
  const text65 = "{}".padEnd(65, " ");
  assert.deepEqual(
    unlimited.push(chunk("seq-big2", 0, 1, 65, Buffer.from(text65, "utf8").toString("base64"))),
    {
      kind: "assembled",
      frame: {},
    },
  );
});

test("两帧交错拒绝并丢弃挂起序列：后续旧序列分片按缺首片拒绝", () => {
  const assembler = new OmpFrameAssembler();
  const parts = fragments({ type: "x" }, 2, "seq-i1");
  assembler.push(parts[0]!);
  assert.deepEqual(assembler.push(chunk("seq-i2", 0, 2, 12, "eyJ0eXBl")), {
    kind: "rejected",
    reason: "interleaved rpc_chunk sequence",
  });
  // 交错拒绝后挂起序列被整体丢弃（协议要求），旧序列再来分片只能按缺首片拒绝。
  assert.deepEqual(assembler.push(parts[1]!), {
    kind: "rejected",
    reason: "rpc_chunk sequence missing initial fragment",
  });
});

test("count=1 单片直通：同一重组管线立即 assembled", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(
    assembler.push(
      chunk("seq-1", 0, 1, 12, Buffer.from('{"type":"x"}', "utf8").toString("base64")),
    ),
    { kind: "assembled", frame: { type: "x" } },
  );
});

test("范围校验：count>byteLength 与 index≥count 拒绝", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(assembler.push(chunk("seq-r1", 0, 5, 4, "eyJh")), {
    kind: "rejected",
    reason: "fragmentCount cannot exceed byteLength",
  });
  assert.deepEqual(assembler.push(chunk("seq-r2", 2, 2, 12, "e30=")), {
    kind: "rejected",
    reason: "fragmentIndex out of range",
  });
});

test("上限更新：合法值生效、恰等于上限不拒；非法值（≤0/NaN）忽略保持现值", () => {
  const assembler = new OmpFrameAssembler();
  assembler.updateMaxReassembledBytes(64);
  assert.deepEqual(assembler.push(chunk("seq-u1", 0, 1, 65, "e30=")), {
    kind: "rejected",
    reason: "reassembled frame exceeds advertised limit",
  });
  assembler.updateMaxReassembledBytes(-1);
  assembler.updateMaxReassembledBytes(Number.NaN);
  assert.deepEqual(assembler.push(chunk("seq-u2", 0, 1, 65, "e30=")), {
    kind: "rejected",
    reason: "reassembled frame exceeds advertised limit",
  });
  assert.deepEqual(
    assembler.push(
      chunk("seq-u3", 0, 1, 64, Buffer.from("{}".padEnd(64, " "), "utf8").toString("base64")),
    ),
    {
      kind: "assembled",
      frame: {},
    },
  );
});

test("流关闭中断：挂起序列按 interrupted 拒绝，二次 abort 无事可报", () => {
  const assembler = new OmpFrameAssembler();
  assembler.push(fragments({ type: "x" }, 2, "seq-abort")[0]!);
  assert.deepEqual(assembler.abort(), {
    kind: "rejected",
    reason: "rpc_chunk sequence interrupted",
  });
  assert.equal(assembler.abort(), null);
});

test("同 chunkId 元数据变化整体拒绝，不以首片声明静默拼接", () => {
  for (const patch of [{ count: 3 }, { byteLength: 50 }]) {
    const assembler = new OmpFrameAssembler();
    const parts = fragments({ type: "x" }, 2, "metadata");
    assert.deepEqual(assembler.push(parts[0]!), { kind: "pending" });
    assert.deepEqual(assembler.push({ ...parts[1]!, ...patch }), {
      kind: "rejected",
      reason: "rpc_chunk sequence metadata mismatch",
    });
    assert.equal(assembler.abort(), null);
  }
});

test("未齐片即超出声明字节数时立即丢弃序列", () => {
  const assembler = new OmpFrameAssembler();
  assert.deepEqual(assembler.push(chunk("overflow", 0, 2, 3, "e30gIA==")), {
    kind: "rejected",
    reason: "rpc_chunk sequence exceeds declared length",
  });
  assert.equal(assembler.abort(), null);
});
