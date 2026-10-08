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
import { engineModelSelectionOf } from "./ompEngineProcess.js";
import type { OmpBtwStore } from "./OmpBtwStore.js";
import { dispatchOmpBtwCommand, isOmpBtwSessionCommand } from "./OmpBtwCommands.js";

const UNSUPPORTED = "fault.command.unsupportedByOmpCore";
const CAP = PROTOCOL_V4_LIMITS.idempotencyTablePerSession;

export interface V4CommandContext {
  registry: SessionRegistry;
  /** v4 createSession 的 workspace 归属（本进程唯一 workspace）。 */
  workspaceId: string;
  workspacePath: string;
  attachments: AttachmentStore;
  sideViews?: OmpBtwStore;
}

export class V4CommandService {
  private idempotency = new Map<string, CommandAck>();
  // 在飞去重表：dispatch 进行期间同 commandId 的重复投递共享同一 promise，
  // 否则幂等表要等 dispatch 完成才 remember，重复投递会完整执行第二次。
  private inFlight = new Map<string, Promise<CommandAck>>();
  private readonly context: V4CommandContext;

  constructor(context: V4CommandContext) {
    this.context = context;
  }

  async handle(raw: unknown): Promise<CommandAck> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      throw new ProtocolError(
        -32602,
        `invalid v4 command envelope: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const envelope = parsed.envelope;
    const key = `${envelope.sessionId ?? "global"}:${envelope.commandId}`;
    const cached = this.idempotency.get(key);
    if (cached) {
      return cached;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
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
    return {
      commandId: envelope.commandId,
      status,
      revisionAtDecision: envelope.sessionId
        ? (this.context.registry.getEngine(envelope.sessionId)?.projection.revision ?? 0)
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
      case "createSession": {
        const payload =
          envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["createSession"];
        // workspace key 是身份边界，路径只用于运行目录；同路径的其他身份也不能放行。
        // 必须先于附件读取和引擎创建拒绝，拒绝 ACK 仍走统一幂等表。
        if (payload.workspaceId !== this.context.workspaceId) {
          return this.ack(envelope, "rejected", {
            reasonCode: "fault.command.workspaceMismatch",
            message: "createSession workspaceId does not match the bound workspace",
          });
        }
        const input = payload.firstInput
          ? prepareOmpAttachmentInput(
              payload.firstInput.text,
              payload.firstInput.attachments,
              this.context.attachments,
            )
          : null;
        if (input && !input.ok)
          return this.ack(envelope, "rejected", {
            reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
            message: input.error,
          });
        const engine = await this.context.registry.createSession({
          workspaceId: this.context.workspaceId,
          workspacePath: this.context.workspacePath,
        });
        if (payload.firstInput) {
          // 临时模型：首发优先 firstInput.modelSelection，回落 config.modelSelection（draft 冻结配置）。
          const selection = engineModelSelectionOf(
            payload.firstInput.modelSelection ?? payload.config?.modelSelection,
          );
          const delivery = await engine.sendText(
            input?.text ?? payload.firstInput.text,
            envelope.commandId,
            envelope.clientId,
            input?.images ?? [],
            selection,
            payload.firstInput.text,
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
        const payload =
          envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"];
        const input = prepareOmpAttachmentInput(
          payload.text,
          payload.attachments,
          this.context.attachments,
        );
        if (!input.ok)
          return this.ack(envelope, "rejected", {
            reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
            message: input.error,
          });
        const engine = this.requireSessionEngine(envelope.sessionId);
        const delivery = await engine.sendText(
          input.text,
          envelope.commandId,
          envelope.clientId,
          input.images,
          engineModelSelectionOf(payload.modelSelection),
          payload.text,
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
          ? this.ack(envelope, "rejected", {
              reasonCode: "fault.command.autoCompactionFailed",
              message: outcome.error,
            })
          : this.ack(envelope, "accepted");
      }
      case "switchModelConfig": {
        const payload =
          envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["switchModelConfig"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        const outcome = await engine.setModel(payload.provider, payload.model, payload.thought);
        if (outcome.error) {
          return this.ack(envelope, "rejected", {
            reasonCode: "fault.command.modelSwitchFailed",
            message: outcome.error,
          });
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
        const payload =
          envelope.payload as import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["resolveInteraction"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        const answer = interactionAnswerOf(payload.answer);
        if (!engine.settleInteraction(payload.interactionId, answer)) {
          return this.ack(envelope, "noop", { reasonCode: "proto.alreadyResolved" });
        }
        engine.projection.resolvePendingInteraction(payload.interactionId);
        return this.ack(envelope, "accepted", {
          result: {
            type: "resolveInteraction",
            resolvedBy: {
              clientId: envelope.clientId,
              ...(payload.answer.optionId ? { optionId: payload.answer.optionId } : {}),
            },
          },
        });
      }
      case "renameSession": {
        const payload = envelope.payload as CommandPayloadMap["renameSession"];
        const sessionId = this.requireSessionId(envelope.sessionId);
        const engine = this.context.registry.getEngine(sessionId);
        if (engine) {
          await engine.rename(payload.title);
          return this.ack(envelope, "accepted");
        }
        // 冷会话（无引擎）改名：真实 omp 的 rename_session 支持未加载会话按稳定 ID 改名
        // （rpc-project-sessions.rename），此前冷会话被 -32004 拒；项目模式不可用（旧核）
        // 维持既有错误语义，omp 失败透传错误码（如 not_found）。
        const outcome = await this.context.registry.renameColdSession(sessionId, payload.title);
        if (!outcome.ok) {
          if (outcome.unsupported) this.requireSessionEngine(envelope.sessionId);
          throw new ProtocolError(
            -32004,
            `session rename failed: ${outcome.error ?? "unknown error"}${outcome.code ? ` [${outcome.code}]` : ""}`,
          );
        }
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
      case "snoozeInteractionAutoResolution": {
        // ask 首次交互 → omp ask_pause（幂等暂停服务端倒计时）+ 投影 snoozed。
        const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
        const engine = this.requireSessionEngine(envelope.sessionId);
        engine.snoozeInteractionAutoResolution(payload.interactionId);
        return this.ack(envelope, "accepted");
      }
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
):
  | { action: "accept"; optionId?: string; freeText?: string; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" } {
  if (answer.action === "decline" || answer.action === "cancel") {
    return { action: answer.action };
  }
  // accept 分支与「缺 action 兼容路径」都必须无损携带全部字段：UI 权限卡拒绝+理由
  // 提交 {optionId, freeText}（无 action），富问答提交 {action, content}，二者缺一不可。
  if (
    answer.action === "accept" ||
    answer.optionId !== undefined ||
    answer.freeText !== undefined ||
    answer.content !== undefined
  ) {
    return {
      action: "accept",
      optionId: answer.optionId,
      freeText: answer.freeText,
      ...(answer.content ? { content: answer.content } : {}),
    };
  }
  return { action: "cancel" };
}

export { commandPayloadSchemas };
