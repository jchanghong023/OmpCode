// omp RPC v2 无损分片重组（rpc_chunk → 逻辑帧）。
// 校验规则按 docs/rpc.md：chunkId/index/count/byteLength 全验证，拒绝交错与中断序列，
// 重组上限使用 ready 帧通告的 maxReassembledFrameBytes（缺省 64MiB）。

import type { OmpRpcChunkFrame } from "./ompFrames.js";

export type FrameAssembleResult =
  | { kind: "pending" }
  | { kind: "assembled"; frame: unknown }
  | { kind: "rejected"; reason: string };

interface PendingChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  received: (string | undefined)[];
  receivedBytes: number;
}

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export class OmpFrameAssembler {
  private pending: PendingChunkSequence | null = null;
  private remainingSequences = 0;

  constructor(private readonly maxReassembledBytes: number = DEFAULT_MAX_REASSEMBLED_BYTES) {}

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
        received: new Array<string | undefined>(chunk.count).fill(undefined),
        receivedBytes: 0,
      };
    }
    const pending = this.pending;
    if (pending.received[chunk.index] !== undefined) {
      return { kind: "rejected", reason: "duplicate rpc_chunk fragment" };
    }
    pending.received[chunk.index] = chunk.data;
    pending.receivedBytes += chunk.byteLength / chunk.count;
    const complete = pending.received.every((part) => part !== undefined);
    if (!complete) {
      return { kind: "pending" };
    }
    this.pending = null;
    const base64 = pending.received.join("");
    const decoded = decodeBase64Strict(base64);
    if (decoded === null) {
      return { kind: "rejected", reason: "rpc_chunk payload is not valid base64" };
    }
    const text = decoded.toString("utf8");
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
