// v4 附件上传事务（begin/chunk/commit/abort）的内存实现。
// 图片作为 ImageContent，UTF-8 文本并入 prompt；omp 不能消费的格式在提交前由调用方拒绝。

import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { ProtocolError } from "./errors.js";

interface StagedAttachment {
  sessionId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
  committed: boolean;
  committedAt: number;
  /**
   * staging 最近活跃时间：begin 时初始化，每次成功 chunk 刷新（滑动 TTL）。
   * sweeper 回收的是"停止推进超过上传 TTL"的 staging——慢速大上传只要仍在推进
   * 就不会被中途回收，同时保留半途而废上传的防泄漏语义；零字节直提的 committed 记录不使用。
   */
  begunAt: number;
}

export class AttachmentStore {
  private staging = new Map<string, StagedAttachment>();
  private committed = new Map<string, StagedAttachment>();
  private sweeper: NodeJS.Timeout | null = null;

  begin(params: {
    connectionId: string;
    uploadId: string;
    sessionId: string;
    fileName: string;
    mime: string;
    totalBytes: number;
    totalChunks: number;
  }) {
    this.ensureSweeper();
    if (params.totalBytes === 0 || params.totalChunks === 0) {
      // 零字节上传直接提交（schema 允许 0/0）。
      const empty: StagedAttachment = {
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: 0,
        totalChunks: 0,
        chunks: new Map(),
        receivedBytes: 0,
        committed: true,
        committedAt: Date.now(),
        begunAt: 0,
      };
      const ref = this.refOf(params.uploadId);
      this.committed.set(ref, empty);
      return { uploadId: params.uploadId, state: "committed" as const, nextChunkIndex: 0, ref };
    }
    this.staging.set(params.uploadId, {
      sessionId: params.sessionId,
      fileName: params.fileName,
      mime: params.mime,
      totalBytes: params.totalBytes,
      totalChunks: params.totalChunks,
      chunks: new Map(),
      receivedBytes: 0,
      committed: false,
      committedAt: 0,
      begunAt: Date.now(),
    });
    return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
  }

  chunk(params: { uploadId: string; chunkIndex: number; dataBase64: string }) {
    const staged = this.staging.get(params.uploadId);
    if (!staged) {
      throw new ProtocolError(-32602, `unknown upload: ${params.uploadId}`);
    }
    if (params.chunkIndex < 0 || params.chunkIndex >= staged.totalChunks) {
      // 越界 index 不可能在合法分片集合内：放行会让"缺 0 号片的 1..N"形态拼出
      // chunks.size === totalChunks 的假象并通过 commit（F15）。
      throw new ProtocolError(
        -32602,
        `attachment chunk index out of range: ${params.chunkIndex} (totalChunks: ${staged.totalChunks})`,
      );
    }
    const bytes = Buffer.from(params.dataBase64, "base64");
    if (bytes.byteLength > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      throw new ProtocolError(-32602, "attachment chunk exceeds limit");
    }
    // 重复 index 幂等替换而非拒绝（F15）：传输层可能重发同一分片，直接拒绝会让
    // 正常重传整单失败；替换前先扣减旧字节，避免 receivedBytes 对同片重复累加。
    const previous = staged.chunks.get(params.chunkIndex);
    if (previous) {
      staged.receivedBytes -= previous.byteLength;
    }
    staged.chunks.set(params.chunkIndex, bytes);
    staged.receivedBytes += bytes.byteLength;
    // 滑动 TTL（F14）：成功写入即刷新活跃时间，上传仍在推进就不被 sweeper 回收。
    staged.begunAt = Date.now();
    return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
  }

  commit(params: { uploadId: string }) {
    const staged = this.staging.get(params.uploadId);
    if (!staged) {
      throw new ProtocolError(-32602, `unknown upload: ${params.uploadId}`);
    }
    if (staged.chunks.size !== staged.totalChunks || staged.receivedBytes > staged.totalBytes) {
      throw new ProtocolError(-32602, "attachment upload incomplete");
    }
    this.staging.delete(params.uploadId);
    const ref = this.refOf(params.uploadId);
    this.committed.set(ref, staged);
    staged.committed = true;
    staged.committedAt = Date.now();
    return { ref };
  }

  abort(params: { uploadId: string }) {
    this.staging.delete(params.uploadId);
  }

  lookup(ref: string): StagedAttachment | null {
    return this.committed.get(ref) ?? null;
  }

  /** 附件字节（已提交）。 */
  bytesOf(ref: string): Buffer | null {
    const attachment = this.committed.get(ref);
    if (!attachment) {
      return null;
    }
    return Buffer.concat(
      [...attachment.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes),
    );
  }

  /** 图片附件 → omp prompt images（仅 image/*；其余类型由调用方转换或拒绝）。 */
  ompImagesOf(ref: string): { type: "image"; data: string; mimeType: string }[] {
    const attachment = this.committed.get(ref);
    const bytes = this.bytesOf(ref);
    if (!attachment || !bytes || !attachment.mime.startsWith("image/")) {
      return [];
    }
    return [{ type: "image", data: bytes.toString("base64"), mimeType: attachment.mime }];
  }

  private refOf(uploadId: string): string {
    return `omp-attachment://${uploadId}`;
  }

  /**
   * 过期清理：committed 按 unreferenced TTL，staging 按上传 TTL（否则半途而废的
   * 上传会永久占内存）；now 注入便于测试。
   */
  sweep(now: number): void {
    const unreferencedTtl = PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs;
    for (const [ref, attachment] of this.committed) {
      if (now - attachment.committedAt > unreferencedTtl) {
        this.committed.delete(ref);
      }
    }
    const uploadTtl = PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
    for (const [uploadId, staged] of this.staging) {
      if (now - staged.begunAt > uploadTtl) {
        this.staging.delete(uploadId);
      }
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) {
      return;
    }
    this.sweeper = setInterval(() => {
      this.sweep(Date.now());
    }, 60_000);
    this.sweeper.unref?.();
  }
}
