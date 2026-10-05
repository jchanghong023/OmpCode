// OmpFrameAssembler（rpc_chunk v2 无损分片重组）UT：钉住当前重组语义（正常序/乱序/
// 缺首片/重复/坏 base64/坏 UTF-8/字节总和不符/坏 JSON/超限/交错/单片直通/范围校验/
// 上限更新/中断），以及 ready 帧通告的 maxReassembledFrameBytes 在 ompProcess /
// ompProjectProcess 的接线（修复 B6：通告上限必须生效——超限分片拒绝、限内分片照常重组）。
// 修复 S3-4 后分片形状与 omp 发送端（rpc-frame.ts）一致：先切 UTF-8 字节再逐片 base64
//（各片自带 padding），重组完成校验实收字节总和、严格 UTF-8 解码。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OmpFrameAssembler } from "../src/domain/frameAssembler.js";
import type { OmpRpcChunkFrame } from "../src/domain/ompFrames.js";
import { createOmpProcessFactory } from "../src/adapters/ompProcess.js";
import { OmpProjectProcess } from "../src/adapters/ompProjectProcess.js";

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

test("重复分片拒绝但不清空序列：补齐其余分片仍可重组", () => {
  const assembler = new OmpFrameAssembler();
  const parts = fragments({ type: "x" }, 2, "seq-d");
  assert.deepEqual(assembler.push(parts[0]!), { kind: "pending" });
  assert.deepEqual(assembler.push(parts[0]!), {
    kind: "rejected",
    reason: "duplicate rpc_chunk fragment",
  });
  assert.deepEqual(assembler.push(parts[1]!), { kind: "assembled", frame: { type: "x" } });
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

// ── ready 通告上限接线（B6）：ompProcess / ompProjectProcess 在 ready 解析后用
// maxReassembledFrameBytes 更新 assembler；用 `node -e` 内联 fake 核驱动真实进程。──

/** 捕获本进程 stderr（适配器 logger 输出）以便断言 debug 级拒绝日志。 */
function captureStderr(): { text(): string; restore(): void } {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((writeChunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof writeChunk === "string" ? writeChunk : String(writeChunk));
    return (original as unknown as (c: unknown, ...r: unknown[]) => boolean).apply(process.stderr, [
      writeChunk,
      ...rest,
    ]);
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// 通告上限取 128：既要让「声明 129 字节」的超限分片被拒，也要让 compact 的分片响应
// （约 91 字节）在限内可重组。
const WIRED_LIMIT = 128;

// 内联 fake 单会话核：ready 通告 128 字节重组上限；set_subagent_subscription 前先发一条
// 声明 129 字节的超限分片（若接线生效必须被拒，否则会被当作 "{}" 重组）；compact 的
// 响应拆成 2 片限内分片返回（若接线误伤则无法重组，命令超时失败）。
const FAKE_SESSION_CORE = `
const { createInterface } = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: ${WIRED_LIMIT} }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription") {
    if (cmd.type === "set_subagent_subscription") {
      process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: "oversize", index: 0, count: 1, byteLength: ${WIRED_LIMIT + 1}, data: Buffer.from("{}").toString("base64") }) + "\\n");
    }
    process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} }) + "\\n");
    return;
  }
  if (cmd.type === "compact") {
    const response = { id: cmd.id, type: "response", command: cmd.type, success: true, data: { ok: true } };
    // 与 omp 发送端（rpc-frame.ts）同形：先切 UTF-8 字节再逐片 base64。
    const bytes = Buffer.from(JSON.stringify(response), "utf8");
    const half = Math.ceil(bytes.byteLength / 2);
    process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: "ok-seq", index: 0, count: 2, byteLength: bytes.byteLength, data: bytes.subarray(0, half).toString("base64") }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: "ok-seq", index: 1, count: 2, byteLength: bytes.byteLength, data: bytes.subarray(half).toString("base64") }) + "\\n");
    return;
  }
});
`;

const scratchRoot = mkdtempSync(join(tmpdir(), "omp-assembler-wire-"));
process.on("exit", () => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

test("ompProcess：ready 通告上限接线——超限分片拒绝、限内分片照常重组", async () => {
  const captured = captureStderr();
  const omp = createOmpProcessFactory(process.execPath, ["-e", FAKE_SESSION_CORE, "--"]).create({
    cwd: scratchRoot,
    onEvent() {},
    onUiRequest() {},
    onExit() {},
  });
  try {
    await omp.start();
    // 超限分片（129 > 128）必须被拒：若未接线（默认 64MiB）会被静默重组为 "{}"。
    assert.match(
      captured.text(),
      /"message":"rpc_chunk sequence rejected".*"reason":"reassembled frame exceeds advertised limit"/,
    );
    // 限内（实际字节数 ≤ 128）分片响应必须照常重组并结算命令。
    const outcome = await omp.send({ type: "compact" });
    assert.equal(outcome.success, true);
    assert.deepEqual(outcome.data, { ok: true });
  } finally {
    captured.restore();
    await omp.dispose();
  }
});

// 内联 fake 项目核：ready（rpc-ui-project）通告 128 字节上限；negotiate_protocol 前先发
// 一条超限分片，再正常响应协商——start() 必须成功且超限分片被拒。
const FAKE_PROJECT_CORE = `
const { createInterface } = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2, 3], maxReassembledFrameBytes: ${WIRED_LIMIT}, mode: "rpc-ui-project", projectIdentity: { projectRoot: process.cwd() }, processInstanceId: "wire-ut", capabilities: { multiSession: true } }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "negotiate_protocol") {
    process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: "oversize", index: 0, count: 1, byteLength: ${WIRED_LIMIT + 1}, data: Buffer.from("{}").toString("base64") }) + "\\n");
    process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { protocolVersion: cmd.protocolVersion } }) + "\\n");
  }
});
`;

test("ompProjectProcess：ready 即接线通告上限——negotiate 前的超限分片被拒，启动不受影响", async () => {
  const captured = captureStderr();
  const process_ = new OmpProjectProcess({
    binaryPath: process.execPath,
    extraArgs: ["-e", FAKE_PROJECT_CORE, "--"],
    cwd: scratchRoot,
    hooks: { onExit: () => {} },
  });
  try {
    assert.equal(await process_.start(), true);
    assert.match(
      captured.text(),
      /"message":"project rpc_chunk sequence rejected".*"reason":"reassembled frame exceeds advertised limit"/,
    );
  } finally {
    captured.restore();
    await process_.dispose();
  }
});
