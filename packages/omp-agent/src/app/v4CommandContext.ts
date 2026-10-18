// v4 命令服务契约（自 v4Commands.ts 拆出，架构 maxFileLines=400）：
// V4CommandContext 是一次进程级 workspace 归属与依赖出口；V4CommandHost 是拆出的命令处理器
// 对服务实例的最小依赖面（ACK 构造 + 会话解析）。两者都是纯契约，不含任何逻辑。

import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentStore } from "./attachmentStore.js";
import type { ConversationEngine } from "./conversationEngine.js";
import type { OmpAttachmentFileReader } from "./ompAttachmentInput.js";
import type { OmpBtwStore } from "./OmpBtwStore.js";
import type { SessionRegistry } from "./sessionRegistry.js";

export interface V4CommandContext {
  registry: SessionRegistry;
  /** v4 createSession 的 workspace 归属（本进程唯一 workspace）。 */
  workspaceId: string;
  workspacePath: string;
  attachments: AttachmentStore;
  attachmentFileReader?: OmpAttachmentFileReader;
  sideViews?: OmpBtwStore;
}

/** 处理器侧的服务出口：ack 复用服务实例的 revisionAtDecision 与诊断语义。 */
export interface V4CommandHost {
  readonly context: V4CommandContext;
  ack(
    envelope: CommandEnvelope,
    status: CommandAck["status"],
    extra?: Partial<CommandAck>,
  ): CommandAck;
  /** 会话 ID 必填校验（拒绝语义与本模块拆分前的 V4CommandService.requireSessionId 一致）。 */
  requireSessionId(sessionId: string | null): string;
  /** 必填会话引擎（未注册会话沿用拆分前的错误语义）。 */
  requireSessionEngine(sessionId: string | null): ConversationEngine;
}
