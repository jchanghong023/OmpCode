// omp RPC v2 无损分片重组（rpc_chunk → 逻辑帧）。
// 校验规则按 docs/rpc.md：index/count/byteLength 范围校验，chunkId 用于检测序列交错；
// 缺首片、重复分片、交错序列整体拒绝；count=1 的单片序列同样走本重组管线。
// 重组上限缺省 64MiB，可经构造传入，或由进程层按 ready 帧通告的
// maxReassembledFrameBytes 更新（见 ompProcess/ompProjectProcess 的接线）。
// 修复（S3-4，对齐 omp 参考实现 RpcFrameDecoder）：
// ① 每片独立做严格 base64 解码（omp 发送端逐片 toString("base64")，各片自带 padding，
//    不可再按「拼合 base64 字符串」整体解码——256KiB 整块片的尾 padding 会让拼合串
//    中部出现 "=" 而被误拒）；② 完成校验实收分片字节总和 === 声明 byteLength；
// ③ 合并字节以 fatal TextDecoder 严格 UTF-8 解码（docs/rpc.md「decode them as strict
//    UTF-8」），坏字节拒绝该帧而非 U+FFFD 照常 JSON.parse。
// 宽容方向保持：不加 chunkId 1..128、单片 256KiB、count≥2 等 omp 上限，避免未来核演进被拒帧。

import type { OmpRpcChunkFrame } from "./ompFrames.js";

export type FrameAssembleResult =
  | { kind: "pending" }
  | { kind: "assembled"; frame: unknown }
  | { kind: "rejected"; reason: string };

interface PendingChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  received: (Buffer | undefined)[];
  receivedBytes: number;
}

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export class OmpFrameAssembler {
  private pending: PendingChunkSequence | null = null;
  private maxReassembledBytes: number;

  constructor(maxReassembledBytes: number = DEFAULT_MAX_REASSEMBLED_BYTES) {
    this.maxReassembledBytes = maxReassembledBytes;
  }

  /** 进程层按 ready 帧通告的 maxReassembledFrameBytes 更新上限；非法值忽略保持现值。 */
  updateMaxReassembledBytes(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) {
      this.maxReassembledBytes = bytes;
    }
  }

  /** 处理一个 rpc_chunk；在最后一个分片到达时返回 assembled。 */
  push(chunk: OmpRpcChunkFrame): FrameAssembleResult {
    if (chunk.count > chunk.byteLength) {
      return { kind: "rejected", reason: "fragmentCount cannot exceed byteLength" };
    }
    if (chunk.index >= chunk.count) {
      return { kind: "rejected", reason: "fragmentIndex out of range" };
    }
    if (chunk.byteLength > this.maxReassembledBytes) {
      return { kind: "rejected", reason: "reassembled frame exceeds advertised limit" };
    }
    if (this.pending && this.pending.chunkId !== chunk.chunkId) {
      // 交错序列：按协议要求整体拒绝。
      this.pending = null;
      return { kind: "rejected", reason: "interleaved rpc_chunk sequence" };
    }
    if (!this.pending) {
      if (chunk.index !== 0) {
        return { kind: "rejected", reason: "rpc_chunk sequence missing initial fragment" };
      }
      this.pending = {
        chunkId: chunk.chunkId,
        count: chunk.count,
        byteLength: chunk.byteLength,
        received: Array<Buffer | undefined>(chunk.count).fill(undefined),
        receivedBytes: 0,
      };
    }
    const pending = this.pending;
    // 每片元数据必须与首片一致；否则可绕过声明上限并把不同逻辑帧拼在一起。
    if (pending.count !== chunk.count || pending.byteLength !== chunk.byteLength) {
      this.pending = null;
      return { kind: "rejected", reason: "rpc_chunk sequence metadata mismatch" };
    }
    if (pending.received[chunk.index] !== undefined) {
      this.pending = null;
      return { kind: "rejected", reason: "duplicate rpc_chunk fragment" };
    }
    // 逐片严格 base64：本片载荷非法时立即拒绝该序列（对齐 RpcFrameDecoder.decodeBase64）。
    const bytes = decodeBase64Strict(chunk.data);
    if (bytes === null) {
      this.pending = null;
      return { kind: "rejected", reason: "rpc_chunk payload is not valid base64" };
    }
    if (pending.receivedBytes + bytes.byteLength > pending.byteLength) {
      this.pending = null;
      return { kind: "rejected", reason: "rpc_chunk sequence exceeds declared length" };
    }
    pending.received[chunk.index] = bytes;
    pending.receivedBytes += bytes.byteLength;
    const complete = pending.received.every((part) => part !== undefined);
    if (!complete) {
      return { kind: "pending" };
    }
    this.pending = null;
    // 修复（S3-4②）：完成校验用实收字节总和，而非 byteLength/count 估算值。
    if (pending.receivedBytes !== pending.byteLength) {
      return {
        kind: "rejected",
        reason: "reassembled fragment bytes do not match declared byteLength",
      };
    }
    const decoded = Buffer.concat(pending.received as Buffer[]);
    let text: string;
    try {
      // 修复（S3-4①）：严格 UTF-8（fatal）——坏字节拒绝整帧，不允许 U+FFFD 静默替换。
      text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      return { kind: "rejected", reason: "reassembled frame is not valid UTF-8" };
    }
    try {
      return { kind: "assembled", frame: JSON.parse(text) };
    } catch {
      return { kind: "rejected", reason: "reassembled frame is not valid JSON" };
    }
  }

  /** 流关闭时调用：挂起序列按协议拒绝。 */
  abort(): FrameAssembleResult | null {
    if (!this.pending) {
      return null;
    }
    this.pending = null;
    return { kind: "rejected", reason: "rpc_chunk sequence interrupted" };
  }
}

function decodeBase64Strict(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64");
}
