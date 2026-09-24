// legacy（session/*）方法处理器：旧链路（task 索引、恢复兜底、附件回退）所需的最小面。
// 插件/工作流/automation/offPeak 族以 -32601 拒绝（FORK.md 已知差异），host 侧按既有降级路径处理。

import { zcodeProtocolMethods } from "@zcode/shared";
import type { SessionRegistry } from "./sessionRegistry.js";
import { ProtocolError } from "./errors.js";
import { buildLegacySnapshot } from "./legacySnapshot.js";
import type { AttachmentStore } from "./attachmentStore.js";
import type { ConversationEngine } from "./conversationEngine.js";

export interface LegacyMethodContext {
  registry: SessionRegistry;
  attachments: AttachmentStore;
  workspacePath: string;
  workspaceKey: string;
  workspaceIdentity?: string;
  /** 最近一次 Account Config 交付回执版本（host 按 revision 回声判等）。 */
  deliveredAccountConfigRevision: string | null;
}

export function createLegacyHandlers(context: LegacyMethodContext) {
  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    [zcodeProtocolMethods.sessionCreate]: async (params) => {
      const record = asRecord(params);
      const engine = await context.registry.createSession({
        workspaceId: context.workspaceKey,
        workspacePath: context.workspacePath,
      });
      if (typeof record?.title === "string" && record.title.length > 0) {
        await engine.rename(record.title);
      }
      return buildLegacySnapshot({ ...context, engine });
    },
    [zcodeProtocolMethods.sessionResume]: async (params) => {
      const record = asRecord(params);
      const sessionId = requiredString(record, "sessionId");
      const engine = await resumeOrReject(context.registry, sessionId, context.workspaceKey, context.workspacePath);
      return buildLegacySnapshot({ ...context, engine });
    },
    [zcodeProtocolMethods.sessionList]: async () => {
      const cold = await context.registry.listLegacySessions(context.workspacePath, context.workspaceKey);
      return { sessions: cold };
    },
    [zcodeProtocolMethods.sessionRead]: async (params) => {
      const record = asRecord(params);
      const engine = await resumeOrReject(context.registry, requiredString(record, "sessionId"), context.workspaceKey, context.workspacePath);
      return buildLegacySnapshot({ ...context, engine, messageLimit: optionalNumber(record, "messageLimit") ?? undefined });
    },
    [zcodeProtocolMethods.sessionMessages]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.requireEngine(requiredString(record, "sessionId"));
      const snapshot = buildLegacySnapshot({ ...context, engine });
      return { messages: (snapshot as { messages?: unknown[] }).messages ?? [] };
    },
    [zcodeProtocolMethods.sessionEvents]: async () => ({ events: [] }),
    [zcodeProtocolMethods.sessionSubscribe]: async (params) => {
      const record = asRecord(params);
      const sessionId = requiredString(record, "sessionId");
      const engine = context.registry.getEngine(sessionId);
      return {
        sessionId,
        eventSeq: engine?.projection.seq ?? 0,
        events: [],
      };
    },
    [zcodeProtocolMethods.sessionSend]: async (params) => {
      const record = asRecord(params);
      const sessionId = requiredString(record, "sessionId");
      const engine = context.registry.requireEngine(sessionId);
      const content = record?.content;
      const text = typeof content === "string" ? content : contentText(content);
      const images = collectImages(context.attachments, record);
      await engine.sendText(text, "legacy-send", "legacy", images);
      return { sessionId, accepted: true as const, stateRevision: engine.projection.revision };
    },
    [zcodeProtocolMethods.sessionStop]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.getEngine(requiredString(record, "sessionId"));
      await engine?.stop();
      return {};
    },
    [zcodeProtocolMethods.sessionCompact]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.getEngine(requiredString(record, "sessionId"));
      await engine?.compact();
      const snapshot = engine ? buildLegacySnapshot({ ...context, engine }) : null;
      return {
        response: "compacted",
        ...(snapshot ? { snapshot } : {}),
        compact: { state: "accepted" as const },
      };
    },
    [zcodeProtocolMethods.sessionClose]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.getEngine(requiredString(record, "sessionId"));
      await engine?.dispose();
      return { closed: true };
    },
    [zcodeProtocolMethods.sessionSetModel]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.requireEngine(requiredString(record, "sessionId"));
      const selection = asRecord(record?.model);
      const provider = selection?.providerId;
      const model = selection?.modelId;
      if (typeof provider !== "string" || typeof model !== "string") {
        throw new ProtocolError(-32602, "model selection required");
      }
      const outcome = await engine.setModel(provider, model);
      if (outcome.error) {
        throw new ProtocolError(-32603, outcome.error);
      }
      return {};
    },
    [zcodeProtocolMethods.sessionSetThoughtLevel]: async (params) => {
      const record = asRecord(params);
      const engine = context.registry.requireEngine(requiredString(record, "sessionId"));
      const level = requiredString(record, "thoughtLevel");
      const outcome = await engine.setThoughtLevel(level);
      if (outcome.error) {
        throw new ProtocolError(-32603, outcome.error);
      }
      return {};
    },
    [zcodeProtocolMethods.sessionSetMode]: async () => ({}),
    [zcodeProtocolMethods.sessionSubagents]: async () => ({
      revision: 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    }),
    [zcodeProtocolMethods.runtimeCapabilities]: async () => ({ independentPlanState: false }),
    [zcodeProtocolMethods.computerUseOperationEvent]: async () => ({}),
    [zcodeProtocolMethods.providerUpdateAccountConfig]: async (params) => {
      // host 侧按「回执 revision === 交付 revision」校验交付完成；必须原样回声。
      // omp 核的模型/凭据体系独立于 ZCode 账号配置，这里只记账不消费 providers 内容。
      const record = asRecord(params);
      const revision = record?.revision;
      const providers = asRecord(record?.providers);
      if (context.deliveredAccountConfigRevision === revision) {
        return {
          receivedRevision: revision,
          providerCount: providers ? Object.keys(providers).length : 0,
          status: "unchanged" as const,
        };
      }
      context.deliveredAccountConfigRevision = typeof revision === "string" ? revision : null;
      return {
        receivedRevision: revision,
        providerCount: providers ? Object.keys(providers).length : 0,
        status: "received" as const,
      };
    },
    [zcodeProtocolMethods.workspaceUpdateInteractionPreferences]: async (params) => {
      // 结果 schema 要求回显 workspace 与生效偏好（zcodeWorkspaceUpdateInteractionPreferencesResultSchema）。
      const record = asRecord(params);
      const preferences = asRecord(record?.preferences) ?? {};
      return {
        workspace: record?.workspace ?? {},
        askUserQuestionAutoResolutionEnabled: preferences.askUserQuestionAutoResolutionEnabled === true,
        snoozedInteractionCount: 0,
      };
    },
    [zcodeProtocolMethods.workspaceUpdateModelIoPreferences]: async (params) => {
      // 回显契约同上（zcodeWorkspaceUpdateModelIoPreferencesResultSchema）。
      const record = asRecord(params);
      return {
        workspace: record?.workspace ?? {},
        fullRetentionEnabled: false,
        updatedSessionCount: 0,
      };
    },
    [zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy]: async () => ({}),
    [zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy]: async () => ({}),
    [zcodeProtocolMethods.workspaceReadPresentation]: async () => ({ presentation: {} }),
    [zcodeProtocolMethods.mcpList]: async () => ({ statuses: {} }),
    [zcodeProtocolMethods.processChildProcesses]: async () => ({ processes: [] }),
  };
  return handlers;
}

async function resumeOrReject(registry: SessionRegistry, sessionId: string, workspaceId: string, workspacePath: string): Promise<ConversationEngine> {
  const existing = registry.getEngine(sessionId);
  if (existing) {
    return existing;
  }
  return registry.resumeSession({ sessionId, workspaceId, workspacePath });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function requiredString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(-32602, `${key} required`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function contentText(content: unknown): string {
  const record = asRecord(content);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (Array.isArray(record.parts)) {
    return record.parts
      .map((part) => asRecord(part))
      .filter((part): part is Record<string, unknown> => Boolean(part) && part?.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function collectImages(attachments: AttachmentStore, params: Record<string, unknown> | null) {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  const rawAttachments = params?.attachments;
  if (!Array.isArray(rawAttachments)) {
    return images;
  }
  for (const entry of rawAttachments) {
    const record = asRecord(entry);
    const ref = record?.ref;
    if (typeof ref === "string") {
      images.push(...attachments.ompImagesOf(ref));
    }
  }
  return images;
}
