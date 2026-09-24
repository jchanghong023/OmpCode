// SessionRegistry：会话引擎注册表 + sessions-index / workspace-config 两个 v4 topic 的权威状态。
// 本适配器进程 = 一个 workspace 的 agent 端点；冷会话来自 omp 会话存储的只读扫描。

import {
  encodeTopicWireFrames,
  utf8JsonByteLength,
  type ConversationRow,
  type SessionSummary,
  type WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { createId, createLogEpoch, createSubscriptionId } from "../domain/ids.js";
import { rowsFromOmpEntries } from "../domain/coldHistory.js";
import { ConversationEngine, deriveTitle } from "./conversationEngine.js";
import { ProtocolError } from "./errors.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "./ports.js";

interface TopicSubscriber {
  subscriptionId: string;
  topic: string;
  lastDeliveredSeq: number;
}

interface WorkspaceIndexState {
  logEpoch: string;
  summaries: Map<string, SessionSummary>;
  subscribers: Map<string, TopicSubscriber>;
  // 每 topic 单调 seq：delta 帧区间 (fromSeq, toSeq] 必须连续（GUI 链路实测踩坑：
  // 重复 fromSeq=0/toSeq=1 会被 assembler 判非单调 → fail-closed 风暴拖垮会话路由）。
  seq: number;
}

export interface RegistryDeps {
  ompFactory: OmpProcessFactory;
  store: OmpStorePort;
  gateway: HostGateway;
}

export class SessionRegistry {
  private engines = new Map<string, ConversationEngine>();
  private indexes = new Map<string, WorkspaceIndexState>();
  private configStates = new Map<string, { logEpoch: string; state: WorkspaceConfigState; seq: number; subscribers: Map<string, TopicSubscriber> }>();
  private primaryWorkspace: { id: string; path: string } | null = null;
  private readonly ompFactory: OmpProcessFactory;
  private readonly store: OmpStorePort;
  private readonly gateway: HostGateway;

  constructor(deps: RegistryDeps) {
    this.ompFactory = deps.ompFactory;
    this.store = deps.store;
    this.gateway = deps.gateway;
  }

  getEngine(sessionId: string): ConversationEngine | null {
    return this.engines.get(sessionId) ?? null;
  }

  requireEngine(sessionId: string): ConversationEngine {
    const engine = this.engines.get(sessionId);
    if (!engine) {
      throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
    }
    return engine;
  }

  async createSession(params: { sessionId?: string; workspaceId: string; workspacePath: string; title?: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    const sessionId = params.sessionId ?? createId("omp-session");
    const engine = new ConversationEngine({
      sessionId,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      ompFactory: this.ompFactory,
      gateway: this.gateway,
      onIndexChange: (changed) => this.upsertEngineSummary(changed),
      initialTitle: params.title,
    });
    this.engines.set(sessionId, engine);
    this.upsertEngineSummary(engine, { createdAt: Date.now(), lastActivityAt: Date.now() });
    return engine;
  }

  /** 恢复会话：冷历史行先行入投影；omp 子进程按 --resume 启动。 */
  async resumeSession(params: { sessionId: string; workspaceId: string; workspacePath: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    const existing = this.engines.get(params.sessionId);
    if (existing) {
      return existing;
    }
    const cold = (await this.store.listSessions(params.workspacePath)).find((session) => session.sessionId === params.sessionId);
    const engine = new ConversationEngine({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      ompFactory: this.ompFactory,
      gateway: this.gateway,
      onIndexChange: (changed) => this.upsertEngineSummary(changed),
      resumeSessionPath: cold?.sessionPath,
      initialTitle: cold?.title ?? undefined,
    });
    if (cold) {
      const entries = await this.store.readSessionEntries(cold.sessionPath);
      const rows: ConversationRow[] = rowsFromOmpEntries(entries);
      engine.hydrateRows(rows);
    }
    this.engines.set(params.sessionId, engine);
    this.upsertEngineSummary(engine, {
      createdAt: cold?.createdAt ?? Date.now(),
      lastActivityAt: cold?.updatedAt ?? Date.now(),
    });
    return engine;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const engine = this.engines.get(sessionId);
    if (engine) {
      await engine.dispose();
      this.engines.delete(sessionId);
      this.emitIndexDelta(engine.workspaceId, { op: "session.removed", sessionId });
      return;
    }
    // 冷会话删除：在 omp 存储内删除该会话文件（与用户在 omp 内删除等效），并从索引摘除。
    if (this.primaryWorkspace) {
      const cold = (await this.store.listSessions(this.primaryWorkspace.path)).find((session) => session.sessionId === sessionId);
      if (cold) {
        await this.store.deleteSession(cold.sessionPath);
        const index = this.indexes.get(this.primaryWorkspace.id);
        index?.summaries.delete(sessionId);
        if (index) {
          this.emitIndexDelta(this.primaryWorkspace.id, { op: "session.removed", sessionId });
        }
        return;
      }
    }
    throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
  }

  upsertEngineSummary(engine: ConversationEngine, overrides?: { createdAt?: number; lastActivityAt?: number }): void {
    const index = this.ensureIndex(engine.workspaceId);
    const state = engine.projection.stateSnapshot;
    const window = engine.projection.buildSnapshot().rows.window;
    const lastAssistant = [...window].reverse().find((row) => row.kind === "assistantText");
    const createdAt = overrides?.createdAt ?? index.summaries.get(engine.sessionId)?.createdAt ?? Date.now();
    const summary: SessionSummary = {
      sessionId: engine.sessionId,
      workspaceId: engine.workspaceId,
      title: state.meta.title,
      titleSource: state.meta.titleSource,
      phase: state.control.phase,
      sessionEnded: state.control.sessionEnded,
      hasBackgroundWork: state.backgroundWorks.some((work) => work.status === "running"),
      pendingInteractionSummary: {
        permissionCount: state.pendingInteractions.filter((item) => item.kind === "permission").length,
        userInputCount: state.pendingInteractions.filter((item) => item.kind === "userInput").length,
      },
      lastActivityAt: overrides?.lastActivityAt ?? Date.now(),
      ...(lastAssistant && lastAssistant.kind === "assistantText"
        ? { lastAssistantPreview: lastAssistant.text.slice(0, 120) }
        : {}),
      createdAt,
    };
    index.summaries.set(engine.sessionId, summary);
    this.emitIndexDelta(engine.workspaceId, { op: "session.upserted", session: summary });
  }

  /** legacy session/list：冷会话 + 引擎会话合并（形状对齐 zcodeSessionInfoSchema）。 */
  async listLegacySessions(workspacePath: string, workspaceKey: string): Promise<Record<string, unknown>[]> {
    const workspace = { workspacePath, workspaceKey };
    const sessions: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const engine of this.engines.values()) {
      seen.add(engine.sessionId);
      const state = engine.projection.stateSnapshot;
      sessions.push({
        sessionId: engine.sessionId,
        workspace,
        sessionKind: "interactive",
        title: state.meta.title,
        mode: "build",
        status: state.control.phase === "running" ? "running" : state.control.phase === "error" ? "error" : "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    for (const cold of await this.store.listSessions(workspacePath)) {
      if (seen.has(cold.sessionId)) {
        continue;
      }
      sessions.push({
        sessionId: cold.sessionId,
        workspace,
        sessionKind: "interactive",
        title: cold.title ?? deriveTitle(cold.firstUserText ?? ""),
        mode: "build",
        status: "completed",
        createdAt: cold.createdAt,
        updatedAt: cold.updatedAt,
      });
    }
    return sessions;
  }

  /** sessions-index / workspace-config 的 same-sub 恢复：按 subscriptionId 反查并重发快照。 */
  resyncIndexOrConfig(
    subscriptionId: string,
    _base: { logEpoch: string; seq: number } | null,
    _forceSnapshot = false,
  ): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    for (const [workspaceId, index] of this.indexes) {
      if (index.subscribers.has(subscriptionId)) {
        this.emitTopicFrame(`sessions-index/${workspaceId}`, subscriptionId, 0, {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            workspaceId,
            logEpoch: index.logEpoch,
            sessions: [...index.summaries.values()],
          },
        }, "recovery");
        return { subscriptionId, mode: "snapshot", logEpoch: index.logEpoch };
      }
    }
    for (const [workspaceId, entry] of this.configStates) {
      if (entry.subscribers.has(subscriptionId)) {
        this.emitTopicFrame(`workspace-config/${workspaceId}`, subscriptionId, 0, {
          kind: "snapshot",
          snapshot: { protocolVersion: 1, workspaceId, logEpoch: entry.logEpoch, config: entry.state },
        }, "recovery");
        return { subscriptionId, mode: "snapshot", logEpoch: entry.logEpoch };
      }
    }
    throw new ProtocolError(-32004, "fault.subscription.notOwned");
  }

  private ensureIndex(workspaceId: string): WorkspaceIndexState {
    let index = this.indexes.get(workspaceId);
    if (!index) {
      index = { logEpoch: createLogEpoch(), summaries: new Map(), subscribers: new Map(), seq: 0 };
      this.indexes.set(workspaceId, index);
    }
    return index;
  }

  /** sessions-index 订阅：冷会话扫描 + 引擎摘要合并成快照。 */
  async subscribeSessionsIndex(params: { workspaceId: string; workspacePath: string; connectionId: string }): Promise<{ subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string }> {
    const index = this.ensureIndex(params.workspaceId);
    for (const cold of await this.store.listSessions(params.workspacePath)) {
      if (index.summaries.has(cold.sessionId) || this.engines.has(cold.sessionId)) {
        continue;
      }
      index.summaries.set(cold.sessionId, {
        sessionId: cold.sessionId,
        workspaceId: params.workspaceId,
        title: cold.title ?? deriveTitle(cold.firstUserText ?? ""),
        titleSource: cold.title ? "custom" : "generated",
        phase: "completedSuccess",
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: cold.updatedAt,
        createdAt: cold.createdAt,
      });
    }
    const subscriptionId = createSubscriptionId();
    index.subscribers.set(subscriptionId, { subscriptionId, topic: `sessions-index/${params.workspaceId}`, lastDeliveredSeq: index.seq });
    index.seq += 1;
    this.emitTopicFrame(`sessions-index/${params.workspaceId}`, subscriptionId, 0, {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: params.workspaceId,
        logEpoch: index.logEpoch,
        sessions: [...index.summaries.values()],
      },
    }, "initial", index.seq);
    const subscriber = index.subscribers.get(subscriptionId)!;
    subscriber.lastDeliveredSeq = index.seq;
    // subscribeAckSchema 要求 mode ∈ snapshot|resume（GUI 链路实测踩坑）。
    return { subscriptionId, mode: "snapshot" as const, logEpoch: index.logEpoch };
  }

  subscribeWorkspaceConfig(params: { workspaceId: string; config: WorkspaceConfigState }): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    let entry = this.configStates.get(params.workspaceId);
    if (!entry) {
      entry = { logEpoch: createLogEpoch(), state: params.config, seq: 1, subscribers: new Map() };
      this.configStates.set(params.workspaceId, entry);
    } else {
      entry.state = params.config;
    }
    const topic = `workspace-config/${params.workspaceId}`;
    const subscriptionId = createSubscriptionId();
    entry.subscribers.set(subscriptionId, { subscriptionId, topic, lastDeliveredSeq: entry.seq });
    this.emitTopicFrame(topic, subscriptionId, 0, {
      kind: "snapshot",
      snapshot: { protocolVersion: 1, workspaceId: params.workspaceId, logEpoch: entry.logEpoch, config: entry.state },
    }, "initial", entry.seq);
    return { subscriptionId, mode: "snapshot" as const, logEpoch: entry.logEpoch };
  }

  updateWorkspaceConfig(workspaceId: string, config: WorkspaceConfigState): void {
    const entry = this.configStates.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.state = config;
    entry.seq += 1;
    for (const subscriber of entry.subscribers.values()) {
      this.emitTopicFrame(subscriber.topic, subscriber.subscriptionId, subscriber.lastDeliveredSeq, {
        kind: "deltas",
        deltas: [{ op: "config.updated", config }],
      }, "online", entry.seq);
      subscriber.lastDeliveredSeq = entry.seq;
    }
  }

  unsubscribe(topic: string, subscriptionId: string): void {
    for (const index of this.indexes.values()) {
      index.subscribers.delete(subscriptionId);
    }
    for (const entry of this.configStates.values()) {
      entry.subscribers.delete(subscriptionId);
    }
  }

  private emitIndexDelta(workspaceId: string, delta: { op: "session.upserted"; session: SessionSummary } | { op: "session.removed"; sessionId: string }): void {
    const index = this.indexes.get(workspaceId);
    if (!index || index.subscribers.size === 0) {
      return;
    }
    index.seq += 1;
    for (const subscriber of index.subscribers.values()) {
      this.emitTopicFrame(subscriber.topic, subscriber.subscriptionId, subscriber.lastDeliveredSeq, {
        kind: "deltas",
        deltas: [delta],
      }, "online", index.seq);
      subscriber.lastDeliveredSeq = index.seq;
    }
  }

  private emitTopicFrame(
    topic: string,
    subscriptionId: string,
    fromSeq: number,
    payload: Record<string, unknown> & { kind: "snapshot" | "deltas" },
    deliveryKind: "initial" | "online" | "recovery",
    toSeq?: number,
  ): void {
    const frame = {
      topic,
      subscriptionId,
      fromSeq,
      toSeq: toSeq ?? fromSeq + 1,
      sentAt: Date.now(),
      payload,
    };
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic,
      subscriptionId,
      logicalFrameId: createId("frame"),
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire: unknown) => utf8JsonByteLength(wire) + 1,
    });
    for (const wire of wires) {
      this.gateway.emitFrame(wire);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.engines.values()].map((engine) => engine.dispose()));
    this.engines.clear();
  }
}
