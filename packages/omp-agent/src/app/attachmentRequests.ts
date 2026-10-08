// 附件请求的共享 schema 校验与分发：从 ServerApp 总装抽离，避免上传边界淹没路由职责。
// 本层不保存 staging；AttachmentStore 仍是字节、声明、归属及完整性验证的唯一 owner。
import {
  V4_METHODS,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentAbortParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentStore } from "./attachmentStore.js";
import { ProtocolError } from "./errors.js";

type AttachmentRequestMethod =
  | typeof V4_METHODS.attachmentBegin
  | typeof V4_METHODS.attachmentChunk
  | typeof V4_METHODS.attachmentCommit
  | typeof V4_METHODS.attachmentAbort;

export function dispatchAttachmentRequest(
  method: AttachmentRequestMethod,
  params: unknown,
  attachments: AttachmentStore,
) {
  // 先校验共享协议形状，再交给 store 按原顺序检查归属与事务状态；不在分发层复制 owner 判断。
  switch (method) {
    case V4_METHODS.attachmentBegin: {
      const parsed = v4AttachmentBeginParamsSchema.safeParse(params);
      if (!parsed.success) throw new ProtocolError(-32602, "invalid attachment begin params");
      // F008：完整共享协议声明交给唯一事务 owner，不能在分发层丢弃 checksum。
      return attachments.begin(parsed.data);
    }
    case V4_METHODS.attachmentChunk: {
      const parsed = v4AttachmentChunkParamsSchema.safeParse(params);
      if (!parsed.success) throw new ProtocolError(-32602, "invalid attachment chunk params");
      return attachments.chunk(parsed.data);
    }
    case V4_METHODS.attachmentCommit: {
      const parsed = v4AttachmentCommitParamsSchema.safeParse(params);
      if (!parsed.success) throw new ProtocolError(-32602, "invalid attachment commit params");
      return attachments.commit(parsed.data);
    }
    case V4_METHODS.attachmentAbort: {
      const parsed = v4AttachmentAbortParamsSchema.safeParse(params);
      if (!parsed.success) throw new ProtocolError(-32602, "invalid attachment abort params");
      attachments.abort(parsed.data);
      return {};
    }
  }
}
