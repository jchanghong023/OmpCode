// SessionIndexTopics：sessions-index / workspace-config 两个 v4 topic 的权威状态与帧发布。
// 从 SessionRegistry 拆出（架构 max-file-lines）；引擎生命周期仍在 SessionRegistry。

import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type SessionSummary,
  type WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createId,
  createLogEpoch,
  createSubscriptionId,
  ompSessionIdOfFilePath,
} from "../domain/ids.js";
import { buildEngineSessionSummary } from "./engineSessionSummary.js";
import { ConversationEngine } from "./conversationEngine.js";
import { deriveTitle } from "../domain/titleText.js";
import { ProtocolError } from "./errors.js";
import type { HostGateway, OmpStorePort } from "./ports.js";

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

export interface SessionIndexHost {
  gateway: HostGateway;
  store: OmpStorePort;
  getEngine(sessionId: string): ConversationEngine | null;
  /** 项目模式主工作区路径（冷会话重扫范围）；未初始化时为 null。 */
  primaryWorkspacePath(): string | null;
  rekeyedEngineIds: Set<string>;
}

export class SessionIndexTopics {
  private indexes = new Map<string, WorkspaceIndexState>();
  private configStates = new Map<
    string,
    {
      logEpoch: string;
      state: WorkspaceConfigState;
      seq: number;
      subscribers: Map<string, TopicSubscriber>;
    }
  >();
  private readonly frameOrdinalsBySubscriptionId = new Map<string, number>();
  private readonly host: SessionIndexHost;

  constructor(host: SessionIndexHost) {
    this.host = host;
  }

  /** 引擎摘要入索引（含临时 ID → omp 文件 UUID 身份迁移；Host 按创建时 task ID 监听终态）。draft 相位不入索引：上游 isDraftSession 过滤（v4-gateway.ts publishCurrentSummaryToIndex）的换核等价实现，缺失会让预热 draft 以「New session」漏进 sessions-index、宿主 task-index 留下幽灵行（见 omp-project-mode.md「草稿预热禁用」）；首发提升为 running 后经 notifyIndexChange 正常入索引。 */
  upsertEngineSummary(
    engine: ConversationEngine,
    overrides?: { createdAt?: number; lastActivityAt?: number },
  ): void {
    if (engine.projection.stateSnapshot.control.phase === "draft") return;
    const index = this.ensureIndex(engine.workspaceId);
    const state = engine.projection.stateSnapshot;
    const persistedId = ompSessionIdOfFilePath(engine.ompSessionFile) ?? engine.sessionId;
    const terminal = ["completedSuccess", "completedInterrupted", "error"].includes(
      state.control.phase,
    );
    const shouldRekey =
      persistedId !== engine.sessionId &&
      terminal &&
      !this.host.rekeyedEngineIds.has(engine.sessionId);
    const indexId = this.host.rekeyedEngineIds.has(engine.sessionId)
      ? persistedId
      : engine.sessionId;
    const createdAt = overrides?.createdAt ?? index.summaries.get(indexId)?.createdAt ?? Date.now();
    const summary = buildEngineSessionSummary({
      engine,
      sessionId: indexId,
      createdAt,
      lastActivityAt: overrides?.lastActivityAt,
    });
    index.summaries.set(indexId, summary);
    this.emitIndexDelta(engine.workspaceId, { op: "session.upserted", session: summary });
    if (shouldRekey) {
      index.summaries.delete(engine.sessionId);
      this.emitIndexDelta(engine.workspaceId, {
        op: "session.removed",
        sessionId: engine.sessionId,
      });
      this.host.rekeyedEngineIds.add(engine.sessionId);
      const stableSummary = { ...summary, sessionId: persistedId };
      index.summaries.set(persistedId, stableSummary);
      this.emitIndexDelta(engine.workspaceId, { op: "session.upserted", session: stableSummary });
    }
  }

  /** 删除索引行（返回是否存在，供调用方决定是否需要额外清理）。 */
  removeSession(workspaceId: string, sessionId: string): boolean {
    const index = this.indexes.get(workspaceId);
    if (index?.summaries.delete(sessionId)) {
      this.emitIndexDelta(workspaceId, { op: "session.removed", sessionId });
      return true;
    }
    return false;
  }

  /** sessions-index / workspace-config 的 same-sub 恢复：按 subscriptionId 反查并重发快照。 */
  resyncIndexOrConfig(
    subscriptionId: string,
    _base: { logEpoch: string; seq: number } | null,
    _forceSnapshot = false,
  ): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    for (const [workspaceId, index] of this.indexes) {
      const subscriber = index.subscribers.get(subscriptionId);
      if (subscriber) {
        this.emitTopicFrame(
          `sessions-index/${workspaceId}`,
          subscriptionId,
          0,
          {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId,
              logEpoch: index.logEpoch,
              sessions: [...index.summaries.values()],
            },
          },
          "recovery",
          index.seq,
        );
        subscriber.lastDeliveredSeq = index.seq;
        return { subscriptionId, mode: "snapshot", logEpoch: index.logEpoch };
      }
    }
    for (const [workspaceId, entry] of this.configStates) {
      const subscriber = entry.subscribers.get(subscriptionId);
      if (subscriber) {
        this.emitTopicFrame(
          `workspace-config/${workspaceId}`,
          subscriptionId,
          0,
          {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId,
              logEpoch: entry.logEpoch,
              config: entry.state,
            },
          },
          "recovery",
          entry.seq,
        );
        subscriber.lastDeliveredSeq = entry.seq;
        return { subscriptionId, mode: "snapshot", logEpoch: entry.logEpoch };
      }
    }
    throw new ProtocolError(-32004, "fault.subscription.notOwned");
  }

  /** sessions_changed（OMP 目录事实变化）：重扫冷会话并同步索引（新增补齐、消失移除）。 */
  async onProjectSessionsChanged(): Promise<void> {
    const workspacePath = this.host.primaryWorkspacePath();
    if (!workspacePath) return;
    for (const [workspaceId, index] of this.indexes) {
      if (index.subscribers.size === 0) continue;
      const cold = await this.host.store.listSessions(workspacePath).catch(() => []);
      const coldIds = new Set(cold.map((session) => session.sessionId));
      for (const session of cold) {
        if (index.summaries.has(session.sessionId) || this.host.getEngine(session.sessionId))
          continue;
        index.summaries.set(session.sessionId, {
          sessionId: session.sessionId,
          workspaceId,
          title: session.title ?? deriveTitle(session.firstUserText ?? ""),
          titleSource: session.title ? "custom" : "generated",
          phase: "completedSuccess",
          sessionEnded: true,
          hasBackgroundWork: false,
          lastActivityAt: session.updatedAt,
          createdAt: session.createdAt,
        });
        this.emitIndexDelta(workspaceId, {
          op: "session.upserted",
          session: index.summaries.get(session.sessionId)!,
        });
      }
      for (const sessionId of index.summaries.keys()) {
        if (
          !coldIds.has(sessionId) &&
          !this.host.getEngine(sessionId) &&
          !sessionId.startsWith("omp-session-")
        ) {
          if (index.summaries.delete(sessionId)) {
            this.emitIndexDelta(workspaceId, { op: "session.removed", sessionId });
          }
        }
      }
    }
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
  async subscribeSessionsIndex(params: {
    workspaceId: string;
    workspacePath: string;
    connectionId: string;
  }): Promise<{ subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string }> {
    const index = this.ensureIndex(params.workspaceId);
    for (const cold of await this.host.store.listSessions(params.workspacePath)) {
      if (index.summaries.has(cold.sessionId) || this.host.getEngine(cold.sessionId)) {
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
    index.subscribers.set(subscriptionId, {
      subscriptionId,
      topic: `sessions-index/${params.workspaceId}`,
      lastDeliveredSeq: index.seq,
    });
    index.seq += 1;
    this.emitTopicFrame(
      `sessions-index/${params.workspaceId}`,
      subscriptionId,
      0,
      {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: params.workspaceId,
          logEpoch: index.logEpoch,
          sessions: [...index.summaries.values()],
        },
      },
      "initial",
      index.seq,
    );
    const subscriber = index.subscribers.get(subscriptionId)!;
    subscriber.lastDeliveredSeq = index.seq;
    // subscribeAckSchema 要求 mode ∈ snapshot|resume（GUI 链路实测踩坑）。
    return { subscriptionId, mode: "snapshot" as const, logEpoch: index.logEpoch };
  }

  subscribeWorkspaceConfig(params: { workspaceId: string; config: WorkspaceConfigState }): {
    subscriptionId: string;
    mode: "snapshot" | "resume";
    logEpoch: string;
  } {
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
    this.emitTopicFrame(
      topic,
      subscriptionId,
      0,
      {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: params.workspaceId,
          logEpoch: entry.logEpoch,
          config: entry.state,
        },
      },
      "initial",
      entry.seq,
    );
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
      this.emitTopicFrame(
        subscriber.topic,
        subscriber.subscriptionId,
        subscriber.lastDeliveredSeq,
        { kind: "deltas", deltas: [{ op: "config.updated", config }] },
        "online",
        entry.seq,
      );
      subscriber.lastDeliveredSeq = entry.seq;
    }
  }

  unsubscribe(topic: string, subscriptionId: string): void {
    void topic;
    this.frameOrdinalsBySubscriptionId.delete(subscriptionId);
    for (const index of this.indexes.values()) {
      index.subscribers.delete(subscriptionId);
    }
    for (const entry of this.configStates.values()) {
      entry.subscribers.delete(subscriptionId);
    }
  }

  private emitIndexDelta(
    workspaceId: string,
    delta:
      | { op: "session.upserted"; session: SessionSummary }
      | { op: "session.removed"; sessionId: string },
  ): void {
    const index = this.indexes.get(workspaceId);
    if (!index || index.subscribers.size === 0) {
      return;
    }
    index.seq += 1;
    for (const subscriber of index.subscribers.values()) {
      this.emitTopicFrame(
        subscriber.topic,
        subscriber.subscriptionId,
        subscriber.lastDeliveredSeq,
        { kind: "deltas", deltas: [delta] },
        "online",
        index.seq,
      );
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
    const logicalFrameOrdinal = (this.frameOrdinalsBySubscriptionId.get(subscriptionId) ?? 0) + 1;
    this.frameOrdinalsBySubscriptionId.set(subscriptionId, logicalFrameOrdinal);
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic,
      subscriptionId,
      logicalFrameId: createId("frame"),
      logicalFrameOrdinal,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    for (const wire of wires) {
      this.host.gateway.emitFrame(wire);
    }
  }

  dispose(): void {
    this.frameOrdinalsBySubscriptionId.clear();
    this.indexes.clear();
    this.configStates.clear();
  }
}
