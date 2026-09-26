// serverApp：ZCode Protocol（legacy + v4）方法分发的总装。
// 由 adapters/protocolServer 驱动 IO；这里只做路由与结果组装。

import {
  V4_METHODS,
  type WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { createLegacyHandlers } from "./legacyMethods.js";
import { normalizeOmpSlashCommands } from "../domain/ompCommands.js";
import { ProtocolError } from "./errors.js";
import { UNSUPPORTED_METHODS } from "./unsupportedMethods.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { V4CommandService } from "./v4Commands.js";
import { AttachmentStore } from "./attachmentStore.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "./ports.js";

export interface ServerAppDeps {
  ompFactory: OmpProcessFactory;
  store: OmpStorePort;
  gateway: HostGateway;
  workspacePath: string;
  workspaceKey: string;
  workspaceIdentity?: string;
  /** 模型目录来源（registry omp 进程的查询结果，由 adapter 层提供）。 */
  loadWorkspaceConfig: () => Promise<WorkspaceConfigState>;
}

export class ServerApp {
  readonly registry: SessionRegistry;
  private readonly commands: V4CommandService;
  private readonly attachments = new AttachmentStore();
  private readonly legacy: Record<string, (params: unknown) => Promise<unknown>>;
  private readonly deps: ServerAppDeps;
  private workspaceConfigCache: WorkspaceConfigState | null = null;
  private workspaceConfigLoading: Promise<WorkspaceConfigState> | null = null;

  constructor(deps: ServerAppDeps) {
    this.deps = deps;
    this.registry = new SessionRegistry({
      ompFactory: deps.ompFactory,
      store: deps.store,
      gateway: deps.gateway,
      onCommandsUpdate: (commands) => this.updateSlashCommands(commands),
    });
    this.commands = new V4CommandService({
      registry: this.registry,
      workspaceId: deps.workspaceKey,
      workspacePath: deps.workspacePath,
      attachments: this.attachments,
    });
    this.legacy = createLegacyHandlers({
      registry: this.registry,
      attachments: this.attachments,
      workspacePath: deps.workspacePath,
      workspaceKey: deps.workspaceKey,
      workspaceIdentity: deps.workspaceIdentity,
      deliveredAccountConfigRevision: null,
      loadWorkspaceConfig: () => this.getWorkspaceConfig(),
    });
  }

  async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (UNSUPPORTED_METHODS.has(method)) {
      throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
    }
    if (this.legacy[method]) {
      return this.legacy[method]!(params);
    }
    switch (method) {
      case V4_METHODS.command:
        return this.commands.handle(params);
      case V4_METHODS.connectionFlow:
        return {};
      case V4_METHODS.conversationSubscribe:
        return this.subscribeConversation(params);
      case V4_METHODS.conversationResync:
        return this.resyncConversation(params);
      case V4_METHODS.conversationUnsubscribe:
        return this.unsubscribe(params);
      case V4_METHODS.conversationRowsRange:
        return this.rowsRange(params);
      case V4_METHODS.conversationFileChanges:
        return this.fileChanges(params);
      case V4_METHODS.conversationPlans:
        return { plans: [], atSeq: 0, atLogEpoch: "omp" };
      case V4_METHODS.conversationUsage: {
        const engine = this.registry.requireEngine(stringField(params, "sessionId"));
        const cumulative = engine.projection.stateSnapshot.usage.cumulative;
        return {
          sessionId: engine.sessionId,
          totalTokens: cumulative.inputTokens + cumulative.outputTokens,
          inputTokens: cumulative.inputTokens,
          outputTokens: cumulative.outputTokens,
          reasoningTokens: 0,
          cacheCreationTokens: cumulative.cacheWriteTokens,
          cacheReadTokens: cumulative.cacheReadTokens,
          modelRequestCount: 0,
          modelErrorCount: 0,
          inputBaselineBySource: {},
        };
      }
      case V4_METHODS.usageStats: {
        const record = asRecord(params);
        const range = typeof record?.range === "string" ? record.range : "7d";
        return {
          range,
          generatedAt: Date.now(),
          timeZone: typeof record?.timeZone === "string" ? record.timeZone : "UTC",
          source: "agent-db",
          summary: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cacheHitRate: 0,
            totalSessions: 0,
            totalTurns: 0,
            toolCallCount: 0,
            toolErrorRate: 0,
            modelErrorRate: 0,
            avgTimeToFirstTokenMs: null,
            avgTurnDurationMs: null,
            activeDays: 0,
            currentStreakDays: 0,
            longestSessionMs: 0,
            longestStreakDays: 0,
            peakDayTokens: 0,
            favoriteModel: null,
          },
          heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
          dailyModelUsage: [],
          models: [],
          tools: [],
        };
      }
      case V4_METHODS.commandsQuery: {
        const record = asRecord(params);
        const commands = Array.isArray(record?.commands) ? record.commands : [];
        return {
          results: commands.map((key) => ({
            key: isRecord(key) ? key : { sessionId: null, commandId: String(key) },
            result: "unknown" as const,
          })),
        };
      }
      case V4_METHODS.attachmentBegin: {
        const record = asRecord(params);
        const result = this.attachments.begin({
          connectionId: stringField(record, "connectionId"),
          uploadId: stringField(record, "uploadId"),
          sessionId: stringField(record, "sessionId"),
          fileName: stringField(record, "fileName"),
          mime: stringField(record, "mime"),
          totalBytes: numberField(record, "totalBytes"),
          totalChunks: numberField(record, "totalChunks"),
        });
        return result.state === "committed"
          ? { uploadId: result.uploadId, state: result.state, nextChunkIndex: result.nextChunkIndex, ref: result.ref }
          : { uploadId: result.uploadId, state: result.state, nextChunkIndex: result.nextChunkIndex };
      }
      case V4_METHODS.attachmentChunk:
        return this.attachments.chunk({
          uploadId: stringField(params, "uploadId"),
          chunkIndex: numberField(params, "chunkIndex"),
          dataBase64: stringField(params, "dataBase64"),
        });
      case V4_METHODS.attachmentCommit:
        return this.attachments.commit({ uploadId: stringField(params, "uploadId") });
      case V4_METHODS.attachmentAbort:
        this.attachments.abort({ uploadId: stringField(params, "uploadId") });
        return {};
      case V4_METHODS.attachmentRead:
        return this.attachmentRead(params);
      case V4_METHODS.conversationAttachmentRead:
      case V4_METHODS.conversationAttachmentStat:
      case V4_METHODS.attachmentPreviewSource:
        throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
      case V4_METHODS.backgroundBashOutput:
      case V4_METHODS.conversationWorkflowRunEvents:
      case V4_METHODS.conversationWorkflowRuns:
      case V4_METHODS.conversationWorkflowRunArtifacts:
      case V4_METHODS.conversationWorkflowRunArtifactData:
      case V4_METHODS.conversationWorkflowRunArtifactRead:
      case V4_METHODS.conversationWorkflowRunWorkspace:
      case V4_METHODS.conversationWorkflowRunNodeResult:
      case V4_METHODS.conversationFileRewindPreview:
        throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
      case V4_METHODS.controllerSubscribe:
      case V4_METHODS.controllerResync:
      case V4_METHODS.controllerUnsubscribe:
        throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
      default:
        throw new ProtocolError(-32601, `unknown method: ${method}`);
    }
  }

  private async getWorkspaceConfig(): Promise<WorkspaceConfigState> {
    if (this.workspaceConfigCache) return this.workspaceConfigCache;
    if (!this.workspaceConfigLoading) {
      this.workspaceConfigLoading = this.deps.loadWorkspaceConfig()
        .then((config) => {
          this.workspaceConfigCache = config;
          return config;
        })
        .finally(() => { this.workspaceConfigLoading = null; });
    }
    return this.workspaceConfigLoading;
  }

  /** omp 命令目录热更新（available_commands_update）：合并进缓存并推送已订阅的 workspace-config topic。 */
  updateSlashCommands(rawCommands: unknown): void {
    if (!this.workspaceConfigCache) {
      return;
    }
    const next = { ...this.workspaceConfigCache, slashCommands: normalizeOmpSlashCommands(rawCommands) };
    this.workspaceConfigCache = next;
    this.registry.updateWorkspaceConfig(this.deps.workspaceKey, next);
  }

  private async subscribeConversation(params: unknown) {
    const record = asRecord(params);
    const topic = stringField(record, "topic");
    // 三个生产 topic 共用同一 subscribe RPC（host 侧按 topic 前缀区分）。
    if (topic.startsWith("sessions-index/")) {
      const ack = await this.registry.subscribeSessionsIndex({
        workspaceId: topic.slice("sessions-index/".length),
        workspacePath: this.deps.workspacePath,
        connectionId: stringField(record, "connectionId"),
      });
      return { ack };
    }
    if (topic.startsWith("workspace-config/")) {
      const config = await this.getWorkspaceConfig();
      const ack = this.registry.subscribeWorkspaceConfig({
        workspaceId: topic.slice("workspace-config/".length),
        config,
      });
      return { ack };
    }
    const sessionId = topic.startsWith("conversation/") ? topic.slice("conversation/".length) : null;
    if (!sessionId) {
      throw new ProtocolError(-32602, "invalid topic");
    }
    let engine = this.registry.getEngine(sessionId);
    if (!engine) {
      engine = await this.registry.resumeSession({
        sessionId,
        workspaceId: this.deps.workspaceKey,
        workspacePath: this.deps.workspacePath,
      });
    }
    const base = asRecord(record?.base);
    const ack = engine.subscribe({
      sessionId,
      connectionId: stringField(record, "connectionId"),
      clientMode: (stringField(record, "clientMode") as "desktop-continuous" | "web-remote-replayable") ?? "desktop-continuous",
      base: base ? { logEpoch: stringField(base, "logEpoch"), seq: numberField(base, "seq") } : null,
    });
    return { ack };
  }

  private async resyncConversation(params: unknown) {
    const record = asRecord(params);
    const subscriptionId = stringField(record, "subscriptionId");
    const forceSnapshot = record?.forceSnapshot === true;
    const base = asRecord(record?.base);
    const baseOrNull = base ? { logEpoch: stringField(base, "logEpoch"), seq: numberField(base, "seq") } : null;
    const topic = stringFieldOrUndefined(record, "topic");
    if (topic !== null && topic.startsWith("conversation/")) {
      const sessionId = topic.slice("conversation/".length);
      if (!sessionId) {
        throw new ProtocolError(-32602, "invalid topic");
      }
      const engine = this.registry.requireEngine(sessionId);
      return { ack: engine.resync(subscriptionId, baseOrNull, forceSnapshot) };
    }
    // sessions-index / workspace-config 的 resync（topic 非会话或缺席）：按 subscriptionId 反查。
    return { ack: this.registry.resyncIndexOrConfig(subscriptionId, baseOrNull, forceSnapshot) };
  }

  private unsubscribe(params: unknown) {
    const record = asRecord(params);
    const topic = stringField(record, "topic");
    const subscriptionId = stringField(record, "subscriptionId");
    const sessionId = topic.startsWith("conversation/") ? topic.slice("conversation/".length) : null;
    if (sessionId) {
      this.registry.getEngine(sessionId)?.unsubscribe(subscriptionId);
    }
    this.registry.unsubscribe(topic, subscriptionId);
    return {};
  }

  private rowsRange(params: unknown) {
    const record = asRecord(params);
    const engine = this.registry.requireEngine(stringField(record, "sessionId"));
    const beforeRowId = numberFieldOrNull(record, "beforeRowId");
    const limit = numberField(record, "limit");
    const page = engine.projection.rowsRange(beforeRowId === null ? undefined : beforeRowId, limit);
    return {
      rows: page.rows,
      atSeq: engine.projection.seq,
      atRevision: engine.projection.revision,
      atLogEpoch: engine.projection.logEpoch,
      hasMore: page.hasMore,
    };
  }

  private fileChanges(params: unknown) {
    const record = asRecord(params);
    const engine = this.registry.requireEngine(stringField(record, "sessionId"));
    const target = asRecord(record?.target);
    const facts = engine.projection.fileChangesForTarget(numberField(target, "rowId"));
    return {
      files: facts.files,
      additions: facts.additions,
      deletions: facts.deletions,
      items: facts.items.map((item) => ({
        path: item.path,
        additions: item.additions,
        deletions: item.deletions,
        writeCount: item.writeCount,
        toolNames: item.toolNames,
        patches: item.patches,
      })),
    };
  }

  private attachmentRead(params: unknown) {
    const record = asRecord(params);
    const bytes = this.attachments.bytesOf(stringField(record, "ref"));
    if (!bytes) {
      throw new ProtocolError(-32004, "attachment not found");
    }
    const offset = numberField(record, "offset");
    const limit = numberField(record, "limit");
    const slice = bytes.subarray(offset, offset + limit);
    const attachment = this.attachments.lookup(stringField(record, "ref"))!;
    const nextOffset = offset + slice.byteLength;
    return {
      dataBase64: slice.toString("base64"),
      mediaType: attachment.mime,
      totalBytes: bytes.byteLength,
      nextOffset: nextOffset < bytes.byteLength ? nextOffset : null,
    };
  }

  async dispose(): Promise<void> {
    await this.registry.dispose();
  }
}

function stringField(source: unknown, key: string): string {
  const record = asRecord(source);
  const value = record?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(-32602, `${key} required`);
  }
  return value;
}

function stringFieldOrUndefined(source: unknown, key: string): string | null {
  const record = asRecord(source);
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(source: unknown, key: string): number {
  const record = asRecord(source);
  const value = record?.[key];
  if (typeof value !== "number") {
    throw new ProtocolError(-32602, `${key} required`);
  }
  return value;
}

function numberFieldOrNull(source: unknown, key: string): number | null {
  const record = asRecord(source);
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
