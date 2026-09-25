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
}

const TTL_MS = PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
void TTL_MS;

export class AttachmentStore {
  private staging = new Map<string, StagedAttachment>();
  private committed = new Map<string, StagedAttachment>();
  private sweeper: NodeJS.Timeout | null = null;

  begin(params: { connectionId: string; uploadId: string; sessionId: string; fileName: string; mime: string; totalBytes: number; totalChunks: number }) {
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
    });
    return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
  }

  chunk(params: { uploadId: string; chunkIndex: number; dataBase64: string }) {
    const staged = this.staging.get(params.uploadId);
    if (!staged) {
      throw new ProtocolError(-32602, `unknown upload: ${params.uploadId}`);
    }
    const bytes = Buffer.from(params.dataBase64, "base64");
    if (bytes.byteLength > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      throw new ProtocolError(-32602, "attachment chunk exceeds limit");
    }
    staged.chunks.set(params.chunkIndex, bytes);
    staged.receivedBytes += bytes.byteLength;
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
    return Buffer.concat([...attachment.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes));
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

  private ensureSweeper(): void {
    if (this.sweeper) {
      return;
    }
    this.sweeper = setInterval(() => {
      const now = Date.now();
      const ttl = PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs;
      for (const [ref, attachment] of this.committed) {
        if (now - attachment.committedAt > ttl) {
          this.committed.delete(ref);
        }
      }
    }, 60_000);
    this.sweeper.unref?.();
  }
}
