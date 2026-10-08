// v4 附件上传事务（begin/chunk/commit/abort）的内存实现。
// 图片作为 ImageContent，UTF-8 文本并入 prompt；omp 不能消费的格式在提交前由调用方拒绝。

import { createHash } from "node:crypto";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginParams,
  type V4AttachmentChunkParams,
  type V4AttachmentCommitParams,
  type V4AttachmentAbortParams,
} from "@zcode/shared/zcode-protocol-v4";
import { ProtocolError } from "./errors.js";

interface StagedAttachment {
  connectionId: string;
  sessionId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
  committed: boolean;
  committedAt: number;
  /**
   * staging 最近活跃时间：begin 时初始化，每次成功 chunk 刷新（滑动 TTL）。
   * sweeper 回收的是"停止推进超过上传 TTL"的 staging——慢速大上传只要仍在推进
   * 就不会被中途回收，同时保留半途而废上传的防泄漏语义；committed 记录不使用此时间。
   */
  begunAt: number;
}

export class AttachmentStore {
  private staging = new Map<string, StagedAttachment>();
  private committed = new Map<string, StagedAttachment>();
  private sweeper: NodeJS.Timeout | null = null;

  begin(params: V4AttachmentBeginParams) {
    if ((params.totalBytes === 0) !== (params.totalChunks === 0)) {
      throw new ProtocolError(-32602, "zero-byte upload must declare zero chunks");
    }
    const existing =
      this.staging.get(params.uploadId) ?? this.committed.get(this.refOf(params.uploadId));
    if (existing) {
      this.requireOwner(existing, params);
      // F008：重发 begin 不能覆盖原事务声明或已提交字节，否则同一 ref 可被换成另一份内容。
      if (
        existing.fileName !== params.fileName ||
        existing.mime !== params.mime ||
        existing.totalBytes !== params.totalBytes ||
        existing.totalChunks !== params.totalChunks ||
        existing.checksum !== params.checksum
      ) {
        throw new ProtocolError(-32602, "attachment upload declaration conflict");
      }
      let nextChunkIndex = 0;
      while (existing.chunks.has(nextChunkIndex)) nextChunkIndex += 1;
      return existing.committed
        ? {
            uploadId: params.uploadId,
            state: "committed" as const,
            nextChunkIndex,
            ref: this.refOf(params.uploadId),
          }
        : { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex };
    }
    this.ensureSweeper();
    // 零字节也先进入 staging；只有 commit 验证空字节串摘要后才能发布 ref。
    this.staging.set(params.uploadId, {
      connectionId: params.connectionId,
      sessionId: params.sessionId,
      fileName: params.fileName,
      mime: params.mime,
      totalBytes: params.totalBytes,
      totalChunks: params.totalChunks,
      checksum: params.checksum,
      chunks: new Map(),
      receivedBytes: 0,
      committed: false,
      committedAt: 0,
      begunAt: Date.now(),
    });
    return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
  }

  chunk(params: V4AttachmentChunkParams) {
    const staged =
      this.staging.get(params.uploadId) ?? this.committed.get(this.refOf(params.uploadId));
    if (!staged) {
      throw new ProtocolError(-32602, `unknown upload: ${params.uploadId}`);
    }
    this.requireOwner(staged, params);
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
    // F008：合法重传保持幂等，冲突同片不得替换已接受的字节或绕过固定摘要声明。
    const previous = staged.chunks.get(params.chunkIndex);
    if (previous && !previous.equals(bytes)) {
      throw new ProtocolError(-32602, "attachment chunk conflict");
    }
    if (!previous) {
      staged.chunks.set(params.chunkIndex, bytes);
      staged.receivedBytes += bytes.byteLength;
    }
    // 成功的 staging 重传仍刷新滑动 TTL；committed 的存活期不由重传延长。
    if (!staged.committed) staged.begunAt = Date.now();
    return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
  }

  commit(params: V4AttachmentCommitParams) {
    const ref = this.refOf(params.uploadId);
    const staged = this.staging.get(params.uploadId) ?? this.committed.get(ref);
    if (!staged) {
      throw new ProtocolError(-32602, `unknown upload: ${params.uploadId}`);
    }
    this.requireOwner(staged, params);
    if (staged.committed) return { ref };
    // F008：分片数齐全不代表正文完整；少字节、多字节都不能发布可供模型读取的 ref。
    if (staged.chunks.size !== staged.totalChunks || staged.receivedBytes !== staged.totalBytes) {
      throw new ProtocolError(-32602, "attachment upload incomplete");
    }
    const hash = createHash("sha256");
    for (let index = 0; index < staged.totalChunks; index += 1) {
      const bytes = staged.chunks.get(index);
      if (!bytes) throw new ProtocolError(-32602, "attachment upload incomplete");
      hash.update(bytes);
    }
    // 按原始分片顺序增量 hash，不为校验额外 concat 整个附件。
    if (`sha256:${hash.digest("hex")}` !== staged.checksum) {
      throw new ProtocolError(-32602, "attachment checksum mismatch");
    }
    this.staging.delete(params.uploadId);
    this.committed.set(ref, staged);
    staged.committed = true;
    staged.committedAt = Date.now();
    return { ref };
  }

  abort(params: V4AttachmentAbortParams) {
    const staged =
      this.staging.get(params.uploadId) ?? this.committed.get(this.refOf(params.uploadId));
    if (staged) this.requireOwner(staged, params);
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
    // S5-7 依据：与 ompAttachmentInput 文本路径一致，规范化 mimeType 参数后缀
    // （如 "image/png;charset=binary" → "image/png"），不把带参数的 mime 原样透传 omp。
    const mime = attachment?.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!attachment || !bytes || !mime.startsWith("image/")) {
      return [];
    }
    return [{ type: "image", data: bytes.toString("base64"), mimeType: mime }];
  }

  private requireOwner(
    attachment: StagedAttachment,
    params: { connectionId: string; sessionId: string },
  ): void {
    // 事务归属固定于 begin；不能仅凭 uploadId 对别的连接/会话提交、写片或撤销。
    if (
      attachment.connectionId !== params.connectionId ||
      attachment.sessionId !== params.sessionId
    ) {
      throw new ProtocolError(-32602, "attachment upload owner mismatch");
    }
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
