// v4/command 服务：信封校验、幂等、CAS 与命令分发。
// omp 无法等价提供的命令以 fault.command.unsupportedByOmpCore 拒绝（差异记录在 FORK.md）。

import {
  commandPayloadSchemas,
  COMMANDS_REQUIRING_BASE_REVISION,
  parseCommandEnvelope,
  PROTOCOL_V4_LIMITS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { createId } from "../domain/ids.js";
import type { AttachmentStore } from "./attachmentStore.js";
import { ProtocolError } from "./errors.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { ConversationEngine } from "./conversationEngine.js";
import { prepareOmpAttachmentInput } from "./ompAttachmentInput.js";

const UNSUPPORTED = "fault.command.unsupportedByOmpCore";
const CAP = PROTOCOL_V4_LIMITS.idempotencyTablePerSession;

export interface V4CommandContext {
  registry: SessionRegistry;
  /** v4 createSession 的 workspace 归属（本进程唯一 workspace）。 */
  workspaceId: string;
  workspacePath: string;
  attachments: AttachmentStore;
}

export class V4CommandService {
  private idempotency = new Map<string, CommandAck>();
  private readonly context: V4CommandContext;

  constructor(context: V4CommandContext) {
    this.context = context;
  }

  async handle(raw: unknown): Promise<CommandAck> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      throw new ProtocolError(-32602, `invalid v4 command envelope: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const envelope = parsed.envelope;
    const key = `${envelope.sessionId ?? "global"}:${envelope.commandId}`;
    const cached = this.idempotency.get(key);
    if (cached) {
      return cached;
    }
    const ack = await this.dispatch(envelope);
    this.remember(key, ack);
    return ack;
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

  private ack(envelope: CommandEnvelope, status: CommandAck["status"], extra: Partial<CommandAck> = {}): CommandAck {
    return {
      commandId: envelope.commandId,
      status,
      revisionAtDecision: envelope.sessionId
        ? this.context.registry.getEngine(envelope.sessionId)?.projection.revision ?? 0
        : 0,
      ...extra,
    };
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
    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      const engine = envelope.sessionId ? this.context.registry.getEngine(envelope.sessionId) : null;
      if (!engine) {
        return this.ack(envelope, "rejected", { reasonCode: "fault.command.sessionNotFound" });
      }
      if (envelope.baseRevision !== engine.projection.revision) {
        return this.staleAck(envelope);
      }
    }
    switch (envelope.type) {
      case "createSession": {
        const payload = envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["createSession"];
        const input = payload.firstInput
          ? prepareOmpAttachmentInput(payload.firstInput.text, payload.firstInput.attachments, this.context.attachments)
          : null;
        if (input && !input.ok) return this.ack(envelope, "rejected", {
          reasonCode: "fault.command.attachmentUnsupportedByOmpCore", message: input.error,
        });
        const engine = await this.context.registry.createSession({
          workspaceId: payload.workspaceId,
          workspacePath: this.context.workspacePath,
        });
        if (payload.firstInput) {
          // 临时模型：首发优先 firstInput.modelSelection，回落 config.modelSelection（draft 冻结配置）。
          const selection = engineModelSelectionOf(payload.firstInput.modelSelection ?? payload.config?.modelSelection);
          const delivery = await engine.sendText(
            input?.text ?? payload.firstInput.text,
            envelope.commandId,
            envelope.clientId,
            input?.images ?? [],
            selection,
          );
          return this.ack(envelope, "accepted", {
            result: {
              type: "createSession",
              sessionId: engine.sessionId,
              input: { delivery, inputId: createId("input") },
            },
          });
        }
        return this.ack(envelope, "accepted", {
          result: { type: "createSession", sessionId: engine.sessionId },
        });
      }
      case "sendText": {
        const payload = envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"];
        const input = prepareOmpAttachmentInput(payload.text, payload.attachments, this.context.attachments);
        if (!input.ok) return this.ack(envelope, "rejected", {
          reasonCode: "fault.command.attachmentUnsupportedByOmpCore", message: input.error,
        });
        const engine = this.requireSessionEngine(envelope.sessionId);
        const delivery = await engine.sendText(
          input.text,
          envelope.commandId,
          envelope.clientId,
          input.images,
          engineModelSelectionOf(payload.modelSelection),
        );
        return this.ack(envelope, "accepted", {
          result: { type: "inputAccepted", delivery, inputId: createId("input") },
        });
      }
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
      case "setAutoCompaction": {
        const payload = envelope.payload as CommandPayloadMap["setAutoCompaction"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        const outcome = await engine.setAutoCompaction(payload.enabled);
        return outcome.error
          ? this.ack(envelope, "rejected", { reasonCode: "fault.command.autoCompactionFailed", message: outcome.error })
          : this.ack(envelope, "accepted");
      }
      case "switchModelConfig": {
        const payload = envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["switchModelConfig"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        const outcome = await engine.setModel(payload.provider, payload.model, payload.thought);
        if (outcome.error) {
          return this.ack(envelope, "rejected", { reasonCode: "fault.command.modelSwitchFailed", message: outcome.error });
        }
        return this.ack(envelope, "accepted");
      }
      case "setFollowupMode": {
        const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
        // guide/queue 都接受：guide 映射 omp steer（本轮引导），queue 映射 follow_up（轮后队列）。
        // 首发前 UI 会用该命令做 CAS 收敛，拒绝会直接炸掉首条消息（实测 GUI 发送失败根因）。
        const engine = this.requireSessionEngine(envelope.sessionId);
        engine.setFollowupMode(payload.mode);
        return this.ack(envelope, "accepted");
      }
      case "resolveInteraction": {
        const payload = envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["resolveInteraction"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        const answer = interactionAnswerOf(payload.answer);
        if (!engine.settleInteraction(payload.interactionId, answer)) {
          return this.ack(envelope, "noop", { reasonCode: "proto.alreadyResolved" });
        }
        engine.projection.resolvePendingInteraction(payload.interactionId);
        return this.ack(envelope, "accepted", {
          result: {
            type: "resolveInteraction",
            resolvedBy: { clientId: envelope.clientId, ...(payload.answer.optionId ? { optionId: payload.answer.optionId } : {}) },
          },
        });
      }
      case "renameSession": {
        const payload = envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["renameSession"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        await engine.rename(payload.title);
        return this.ack(envelope, "accepted");
      }
      case "deleteSession": {
        await this.context.registry.deleteSession(this.requireSessionId(envelope.sessionId));
        return this.ack(envelope, "accepted");
      }
      case "setAutoDrain":
        // omp 队列始终自动排空；该命令在空队列上幂等成立。
        this.requireSessionEngine(envelope.sessionId);
        return this.ack(envelope, "accepted");
      case "snoozeInteractionAutoResolution":
        this.requireSessionEngine(envelope.sessionId);
        return this.ack(envelope, "accepted");
      case "cancelBackgroundWork":
        return this.ack(envelope, "rejected", {
          reasonCode: "fault.command.backgroundWorkCancelRejected.not_found",
          message: "omp core has no background work",
        });
      case "switchCollaborationMode":
        return this.unsupportedAck(envelope, "collaboration mode switching");
      case "sendGoalCommand":
      case "pauseGoal":
      case "resumeGoal":
        return this.unsupportedAck(envelope, "goal loop");
      case "createSelectionSideSession":
        return this.unsupportedAck(envelope, "selection side sessions");
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

function interactionAnswerOf(
  answer: import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["resolveInteraction"]["answer"],
): { action: "accept"; optionId?: string; freeText?: string } | { action: "decline" } | { action: "cancel" } {
  if (answer.action === "decline" || answer.action === "cancel") {
    return { action: answer.action };
  }
  if (answer.action === "accept") {
    return { action: "accept", optionId: answer.optionId, freeText: answer.freeText };
  }
  if (answer.optionId !== undefined) {
    return { action: "accept", optionId: answer.optionId };
  }
  if (answer.freeText !== undefined) {
    return { action: "accept", freeText: answer.freeText };
  }
  return { action: "cancel" };
}

/** UI 提交的 ModelSelection（providerId/modelId/options.reasoningLevel）→ omp set_model 参数。 */
function engineModelSelectionOf(
  selection: { providerId?: string; modelId?: string; options?: { reasoningLevel?: string } } | undefined | null,
): { provider: string; model: string; thought?: string } | undefined {
  if (!selection || typeof selection.providerId !== "string" || typeof selection.modelId !== "string") {
    return undefined;
  }
  if (selection.providerId.length === 0 || selection.modelId.length === 0) {
    return undefined;
  }
  const thought =
    typeof selection.options?.reasoningLevel === "string" && selection.options.reasoningLevel.length > 0
      ? selection.options.reasoningLevel
      : undefined;
  return { provider: selection.providerId, model: selection.modelId, thought };
}

export { commandPayloadSchemas };
