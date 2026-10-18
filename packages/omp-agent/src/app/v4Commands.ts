// omp 无法等价提供的命令以 fault.command.unsupportedByOmpCore 拒绝（差异记录在 FORK.md）。

import {
  COMMANDS_REQUIRING_BASE_REVISION,
  parseCommandEnvelope,
  PROTOCOL_V4_LIMITS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationEngine } from "./conversationEngine.js";
import { ProtocolError } from "./errors.js";
import type { V4CommandContext, V4CommandHost } from "./v4CommandContext.js";
import {
  handleCancelBackgroundWorkCommand,
  handleCreateSessionCommand,
  handleRenameSessionCommand,
  handleResolveInteractionCommand,
  handleSendTextCommand,
  handleSetAutoCompactionCommand,
  handleSetFollowupModeCommand,
  handleSwitchModelConfigCommand,
} from "./v4CommandHandlers.js";
import { dispatchOmpBtwCommand, isOmpBtwSessionCommand } from "./OmpBtwCommands.js";
import * as commandDiagnostics from "./ompCommandDiagnostics.js";

// 上下文契约拆到 v4CommandContext 后仍在本模块转出，调用方（含测试）import 路径不变。
export type { V4CommandContext };

const UNSUPPORTED = "fault.command.unsupportedByOmpCore";
const CAP = PROTOCOL_V4_LIMITS.idempotencyTablePerSession;

export class V4CommandService {
  private idempotency = new Map<string, CommandAck>();
  // 在飞去重表：dispatch 进行期间同 commandId 的重复投递共享同一 promise，
  // 否则幂等表要等 dispatch 完成才 remember，重复投递会完整执行第二次。
  private inFlight = new Map<string, Promise<CommandAck>>();
  private readonly context: V4CommandContext;
  // 拆出的处理器只依赖 ACK/会话解析出口；端口对象随服务实例构造一次，不按命令分配。
  private readonly host: V4CommandHost;

  constructor(context: V4CommandContext) {
    this.context = context;
    this.host = {
      context,
      ack: (envelope, status, extra) => this.ack(envelope, status, extra),
      requireSessionId: (id) => this.requireSessionId(id),
      requireSessionEngine: (id) => this.requireSessionEngine(id),
    };
  }

  async handle(raw: unknown): Promise<CommandAck> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      commandDiagnostics.envelopeRejected(parsed.error.issues.length);
      throw new ProtocolError(
        -32602,
        `invalid v4 command envelope: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const envelope = parsed.envelope;
    const key = `${envelope.sessionId ?? "global"}:${envelope.commandId}`;
    const cached = this.idempotency.get(key);
    if (cached) {
      commandDiagnostics.deduplicated(envelope, cached);
      return cached;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      commandDiagnostics.deduplicated(envelope);
      return pending;
    }
    commandDiagnostics.received(envelope);
    // 失败路径：finally 先清在飞项让后续投递可重试，错误沿 promise 原样抛给所有等待者，不改写 ack。
    const promise = this.dispatch(envelope)
      .then((ack) => {
        this.remember(key, ack);
        return ack;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private remember(key: string, ack: CommandAck): void {
    this.idempotency.set(key, ack);
    if (this.idempotency.size > CAP) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest !== undefined) {
        this.idempotency.delete(oldest);
      }
    }
  }

  private ack(
    envelope: CommandEnvelope,
    status: CommandAck["status"],
    extra: Partial<CommandAck> = {},
  ): CommandAck {
    const ack: CommandAck = {
      commandId: envelope.commandId,
      status,
      revisionAtDecision: envelope.sessionId
        ? (this.context.registry.getEngine(envelope.sessionId)?.projection.revision ?? 0)
        : 0,
      ...extra,
    };
    commandDiagnostics.acknowledged(envelope, status, ack);
    return ack;
  }

  private staleAck(envelope: CommandEnvelope): CommandAck {
    return this.ack(envelope, "stale", { reasonCode: "fault.command.staleRevision" });
  }

  private unsupportedAck(envelope: CommandEnvelope, what: string): CommandAck {
    return this.ack(envelope, "rejected", {
      reasonCode: UNSUPPORTED,
      message: `${what} is not available with the omp core; see FORK.md known differences`,
    });
  }

  private async dispatch(envelope: CommandEnvelope): Promise<CommandAck> {
    if (envelope.type === "createSelectionSideSession" || isOmpBtwSessionCommand(envelope)) {
      return dispatchOmpBtwCommand(envelope, this.context.sideViews, {
        ack: (status, extra) => this.ack(envelope, status, extra),
        unsupported: (what) => this.unsupportedAck(envelope, what),
        requireSessionId: (id) => this.requireSessionId(id),
      });
    }
    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      const engine = envelope.sessionId
        ? this.context.registry.getEngine(envelope.sessionId)
        : null;
      if (!engine) {
        return this.ack(envelope, "rejected", { reasonCode: "fault.command.sessionNotFound" });
      }
      if (envelope.baseRevision !== engine.projection.revision) {
        return this.staleAck(envelope);
      }
    }
    switch (envelope.type) {
      case "createSession":
        return handleCreateSessionCommand(this.host, envelope);
      case "sendText":
        return handleSendTextCommand(this.host, envelope);
      case "stop": {
        const engine = this.requireSessionEngine(envelope.sessionId);
        await engine.stop();
        return this.ack(envelope, "accepted");
      }
      case "compact": {
        const engine = this.requireSessionEngine(envelope.sessionId);
        await engine.compact();
        return this.ack(envelope, "accepted");
      }
      case "setAutoCompaction":
        return handleSetAutoCompactionCommand(this.host, envelope);
      case "switchModelConfig":
        return handleSwitchModelConfigCommand(this.host, envelope);
      case "setFollowupMode":
        return handleSetFollowupModeCommand(this.host, envelope);
      case "resolveInteraction":
        return handleResolveInteractionCommand(this.host, envelope);
      case "renameSession":
        return handleRenameSessionCommand(this.host, envelope);
      case "deleteSession": {
        await this.context.registry.deleteSession(this.requireSessionId(envelope.sessionId));
        return this.ack(envelope, "accepted");
      }
      case "setAutoDrain": {
        const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
        this.requireSessionEngine(envelope.sessionId).setAutoDrain(payload.autoDrain);
        return this.ack(envelope, "accepted");
      }
      case "snoozeInteractionAutoResolution": {
        // ask 首次交互 → omp ask_pause（幂等暂停服务端倒计时）+ 投影 snoozed。
        const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        engine.snoozeInteractionAutoResolution(payload.interactionId);
        return this.ack(envelope, "accepted");
      }
      case "cancelBackgroundWork":
        return handleCancelBackgroundWorkCommand(this.host, envelope);
      case "switchCollaborationMode":
        return this.unsupportedAck(envelope, "collaboration mode switching");
      case "sendGoalCommand":
      case "pauseGoal":
      case "resumeGoal":
        return this.unsupportedAck(envelope, "goal loop");
      case "forkAssistant":
        return this.unsupportedAck(envelope, "forking a turn");
      case "retryTurn":
        return this.unsupportedAck(envelope, "turn retry");
      case "editUserQuery":
        return this.unsupportedAck(envelope, "editing a sent query");
      case "applyFileRewind":
        return this.unsupportedAck(envelope, "workspace file rewind");
      case "setAssistantFeedback":
        return this.unsupportedAck(envelope, "assistant feedback");
      case "sendQueuedNow":
      case "editQueueItem":
      case "reorderQueueItem":
      case "deleteQueueItem":
        return this.unsupportedAck(envelope, "queue editing");
      case "respondWorkspaceHookReview":
      case "toggleWorkspaceHookReviewItem":
      case "revokeWorkspaceHookTrust":
      case "requestWorkspaceHookReview":
        return this.unsupportedAck(envelope, "workspace hook review");
      case "startSavedWorkflow":
      case "resumeWorkflowRun":
      case "amendWorkflowRunSettings":
        return this.unsupportedAck(envelope, "saved workflow runs");
      case "discardSharedContext":
        return this.unsupportedAck(envelope, "shared context import");
      default: {
        const exhaustive: never = envelope.type;
        return this.unsupportedAck(envelope, String(exhaustive));
      }
    }
  }

  private requireSessionId(sessionId: string | null): string {
    if (!sessionId) {
      throw new ProtocolError(-32602, "sessionId required");
    }
    return sessionId;
  }

  private requireSessionEngine(sessionId: string | null): ConversationEngine {
    return this.context.registry.requireEngine(this.requireSessionId(sessionId));
  }
}
