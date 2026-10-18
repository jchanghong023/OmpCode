// v4 命令处理器（自 v4Commands.ts 的 dispatch 拆出，架构 maxFileLines=400）：
// 每个处理器与拆分前对应 case 逐语句一致，只把服务实例依赖换成 V4CommandHost 出口
// （ack / requireSessionId / requireSessionEngine / context），payload 类型注解改用已导入的
// CommandPayloadMap 别名（等价于拆分前的 inline import() 写法）。行为、ACK 字段与顺序不变。

import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { createId } from "../domain/ids.js";
import { cancelBackgroundWork } from "./backgroundWorkCancellation.js";
import { ProtocolError } from "./errors.js";
import { engineModelSelectionOf } from "./ompEngineProcess.js";
import { prepareOmpAttachmentInput } from "./ompAttachmentInput.js";
import type { V4CommandHost } from "./v4CommandContext.js";

export async function handleCreateSessionCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  // workspace key 是身份边界，路径只用于运行目录；同路径的其他身份也不能放行。
  // 必须先于附件读取和引擎创建拒绝，拒绝 ACK 仍走统一幂等表。
  if (payload.workspaceId !== host.context.workspaceId) {
    return host.ack(envelope, "rejected", {
      reasonCode: "fault.command.workspaceMismatch",
      message: "createSession workspaceId does not match the bound workspace",
    });
  }
  const input = payload.firstInput
    ? await prepareOmpAttachmentInput(
        payload.firstInput.text,
        payload.firstInput.attachments,
        host.context.attachments,
        host.context.attachmentFileReader,
      )
    : null;
  if (input && !input.ok)
    return host.ack(envelope, "rejected", {
      reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
      message: input.error,
    });
  const engine = await host.context.registry.createSession({
    workspaceId: host.context.workspaceId,
    workspacePath: host.context.workspacePath,
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
    return host.ack(envelope, "accepted", {
      result: {
        type: "createSession",
        // 原生命令可在 ACK 前终结并迁移索引；不能再返回已移除的临时 ID，否则宿主会重建幽灵任务。
        sessionId: host.context.registry.upsertEngineSummary(engine),
        input: { delivery, inputId: createId("input") },
      },
    });
  }
  return host.ack(envelope, "accepted", {
    result: { type: "createSession", sessionId: engine.sessionId },
  });
}

export async function handleSendTextCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["sendText"];
  const input = await prepareOmpAttachmentInput(
    payload.text,
    payload.attachments,
    host.context.attachments,
    host.context.attachmentFileReader,
  );
  if (!input.ok)
    return host.ack(envelope, "rejected", {
      reasonCode: "fault.command.attachmentUnsupportedByOmpCore",
      message: input.error,
    });
  const engine = host.requireSessionEngine(envelope.sessionId);
  const delivery = await engine.sendText(
    input.text,
    envelope.commandId,
    envelope.clientId,
    input.images,
    engineModelSelectionOf(payload.modelSelection),
    payload.text,
  );
  return host.ack(envelope, "accepted", {
    result: { type: "inputAccepted", delivery, inputId: createId("input") },
  });
}

export async function handleSetAutoCompactionCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["setAutoCompaction"];
  const engine = host.requireSessionEngine(envelope.sessionId);
  const outcome = await engine.setAutoCompaction(payload.enabled);
  return outcome.error
    ? host.ack(envelope, "rejected", {
        reasonCode: "fault.command.autoCompactionFailed",
        message: outcome.error,
      })
    : host.ack(envelope, "accepted");
}

export async function handleSwitchModelConfigCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
  const engine = host.requireSessionEngine(envelope.sessionId);
  const outcome = await engine.setModel(payload.provider, payload.model, payload.thought);
  if (outcome.error) {
    return host.ack(envelope, "rejected", {
      reasonCode: "fault.command.modelSwitchFailed",
      message: outcome.error,
    });
  }
  return host.ack(envelope, "accepted");
}

export async function handleSetFollowupModeCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  // guide/queue 都接受：guide 映射真实 steer，queue 留在 owner 等待轮后 prompt。
  // 首发前 UI 会用该命令做 CAS 收敛，拒绝会直接炸掉首条消息（实测 GUI 发送失败根因）。
  const engine = host.requireSessionEngine(envelope.sessionId);
  engine.setFollowupMode(payload.mode);
  return host.ack(envelope, "accepted");
}

export async function handleResolveInteractionCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const engine = host.requireSessionEngine(envelope.sessionId);
  const answer = interactionAnswerOf(payload.answer);
  if (!engine.settleInteraction(payload.interactionId, answer)) {
    return host.ack(envelope, "noop", { reasonCode: "proto.alreadyResolved" });
  }
  engine.projection.resolvePendingInteraction(payload.interactionId);
  return host.ack(envelope, "accepted", {
    result: {
      type: "resolveInteraction",
      resolvedBy: {
        clientId: envelope.clientId,
        ...(payload.answer.optionId ? { optionId: payload.answer.optionId } : {}),
      },
    },
  });
}

export async function handleRenameSessionCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const payload = envelope.payload as CommandPayloadMap["renameSession"];
  const sessionId = host.requireSessionId(envelope.sessionId);
  const engine = host.context.registry.getEngine(sessionId);
  if (engine) {
    await engine.rename(payload.title);
    return host.ack(envelope, "accepted");
  }
  // 冷会话（无引擎）改名：真实 omp 的 rename_session 支持未加载会话按稳定 ID 改名
  // （rpc-project-sessions.rename），此前冷会话被 -32004 拒；项目模式不可用（旧核）
  // 维持既有错误语义，omp 失败透传错误码（如 not_found）。
  const outcome = await host.context.registry.renameColdSession(sessionId, payload.title);
  if (!outcome.ok) {
    if (outcome.unsupported) host.requireSessionEngine(envelope.sessionId);
    throw new ProtocolError(
      -32004,
      `session rename failed: ${outcome.error ?? "unknown error"}${outcome.code ? ` [${outcome.code}]` : ""}`,
    );
  }
  return host.ack(envelope, "accepted");
}

export async function handleCancelBackgroundWorkCommand(
  host: V4CommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const { status, ...extra } = await cancelBackgroundWork(
    host.context.registry,
    host.context.workspaceId,
    envelope,
  );
  return host.ack(envelope, status, extra);
}

function interactionAnswerOf(
  answer: CommandPayloadMap["resolveInteraction"]["answer"],
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
