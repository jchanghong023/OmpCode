import type {
  ZCodeAgentInteractionCoverage,
  ZCodeSessionAgentInteractionsResult,
} from "@zcode/shared";
import {
  childrenFromInteractionRecords,
  type InteractionChild,
  type InteractionSource,
} from "../domain/OmpAgentInteractionRecords.js";
import { buildInteractionSnapshot } from "../domain/OmpAgentInteractionSnapshot.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";
import { ProtocolError } from "./errors.js";
import { diagnostics } from "./diagnostics.js";
import { ompHistoryOutcome } from "../domain/OmpSubagentHistory.js";
import type { ConversationEngine } from "./conversationEngine.js";
import type { OmpStorePort, OmpSessionProcess } from "./ports.js";

type Issue = ZCodeAgentInteractionCoverage["issues"][number];
const terminalStatuses = new Set([
  "completed",
  "success",
  "failed",
  "error",
  "cancelled",
  "aborted",
  "parked",
  "interrupted",
  "lost",
]);
interface CachedFile {
  version: string;
  entries: unknown[];
  available: boolean;
  truncated: boolean;
}
interface Snapshot extends ZCodeSessionAgentInteractionsResult {}
interface State {
  files: Map<string, CachedFile>;
  snapshots: Map<number, Snapshot>;
  revision: number;
  signature: string;
  liveRevision?: number;
  liveSources?: InteractionSource[];
  childrenCache: Map<string, { entries: readonly unknown[]; children: InteractionChild[] }>;
  sourceProcess?: OmpSessionProcess | null;
  processRevision: number;
  loading?: Promise<Snapshot>;
}

/** 单一会话读面 owner：live 由 engine 观察，文件缓存只是 OMP 原始记录的版本化派生。 */
export class OmpAgentInteractionStore {
  private readonly states = new WeakMap<ConversationEngine, State>();
  constructor(private readonly store: OmpStorePort) {}

  async query(
    engine: ConversationEngine,
    cursor: string | undefined,
    limit: number,
    isCurrent: () => boolean,
  ): Promise<ZCodeSessionAgentInteractionsResult> {
    let state = this.states.get(engine);
    if (!state) {
      state = {
        files: new Map(),
        snapshots: new Map(),
        revision: 0,
        signature: "",
        childrenCache: new Map(),
        processRevision: 0,
      };
      this.states.set(engine, state);
    }
    const startedAt = Date.now();
    let snapshot: Snapshot;
    let offset = 0;
    if (cursor) {
      const match = /^(\d+):(\d+)$/.exec(cursor);
      if (!match) {
        diagnostics.warn("omp.agent_interactions.cursor.rejected", {
          sessionId: engine.sessionId,
          failureStage: "cursor_format",
          protocolCode: -32602,
        });
        throw new ProtocolError(-32602, "invalid agent interaction cursor");
      }
      const stored = state.snapshots.get(Number(match[1]));
      if (!stored) {
        diagnostics.warn("omp.agent_interactions.cursor.expired", {
          sessionId: engine.sessionId,
          protocolCode: -32009,
          currentRevision: state.revision,
          snapshotCount: state.snapshots.size,
        });
        throw new ProtocolError(-32009, "agent interaction snapshot expired; restart query");
      }
      snapshot = stored;
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset > snapshot.totalEvents) {
        diagnostics.warn("omp.agent_interactions.cursor.rejected", {
          sessionId: engine.sessionId,
          failureStage: "cursor_offset",
          protocolCode: -32602,
          totalEventCount: snapshot.totalEvents,
        });
        throw new ProtocolError(-32602, "invalid agent interaction cursor");
      }
    } else {
      const target = state;
      if (!target.loading)
        target.loading = this.refresh(engine, target).finally(() => {
          target.loading = undefined;
        });
      snapshot = await target.loading;
    }
    if (!isCurrent()) {
      diagnostics.warn("omp.agent_interactions.query.stale", {
        sessionId: engine.sessionId,
        revision: snapshot.revision,
        protocolCode: -32004,
        failureStage: "process_fence",
      });
      throw new ProtocolError(-32004, "agent interaction session changed during read");
    }
    const end = Math.min(offset + limit, snapshot.totalEvents);
    const events = snapshot.events.slice(offset, end);
    const hasNextPage = end < snapshot.totalEvents;
    const result = {
      ...snapshot,
      events,
      ...(hasNextPage ? { nextCursor: `${snapshot.revision}:${end}` } : {}),
    };
    diagnostics.debug("omp.agent_interactions.query.page", {
      sessionId: engine.sessionId,
      revision: snapshot.revision,
      offset,
      limit,
      pageEventCount: events.length,
      totalEventCount: snapshot.totalEvents,
      hasNextPage,
      coverageStatus: snapshot.coverage.status,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  }

  private async readFile(
    state: State,
    path: string,
    ancestry: readonly string[],
  ): Promise<CachedFile> {
    const key = `${path}\0${ancestry.join("/")}`;
    const prior = state.files.get(key);
    const readStartedAt = Date.now();
    const readMode = this.store.readInteractionEntries ? "versioned" : "legacy";
    diagnostics.debug("omp.agent_interactions.history_read.started", {
      ancestryDepth: ancestry.length,
      cacheHit: Boolean(prior),
      readMode,
    });
    if (this.store.readInteractionEntries) {
      const current = await this.store.readInteractionEntries(path, ancestry, prior?.version);
      const result: CachedFile = {
        version: current.version,
        entries: current.entries ?? prior?.entries ?? [],
        available: current.available,
        truncated:
          current.truncated ??
          (current.entries === undefined ? (prior?.truncated ?? false) : false),
      };
      const fields = {
        ancestryDepth: ancestry.length,
        cacheHit: Boolean(prior),
        entryCount: result.entries.length,
        available: result.available,
        truncated: result.truncated,
        versionChanged: prior ? current.version !== prior.version : undefined,
        elapsedMs: Date.now() - readStartedAt,
      };
      if (result.available && !result.truncated)
        diagnostics.debug("omp.agent_interactions.history_read.completed", fields);
      else diagnostics.warn("omp.agent_interactions.history_read.completed", fields);
      state.files.set(key, result);
      return result;
    }
    const entries =
      ancestry.length === 0
        ? await this.store.readSessionEntries(path)
        : ancestry.length === 1
          ? await this.store.readSubagentEntries(path, ancestry[0]!)
          : [];
    diagnostics.debug("omp.agent_interactions.history_read.completed", {
      ancestryDepth: ancestry.length,
      cacheHit: Boolean(prior),
      readMode,
      readAttempted: ancestry.length <= 1,
      entryCount: entries.length,
      elapsedMs: Date.now() - readStartedAt,
    });
    // 兼容测试端口只承担已有直接子代理入口；生产端口提供逐级受控后代读取。
    return {
      version: JSON.stringify(entries),
      entries,
      available: entries.length > 0,
      truncated: false,
    };
  }

  private async refresh(engine: ConversationEngine, state: State): Promise<Snapshot> {
    const refreshStartedAt = Date.now();
    diagnostics.debug("omp.agent_interactions.refresh.started", {
      sessionId: engine.sessionId,
      revision: state.revision,
      fileCacheCount: state.files.size,
      snapshotCount: state.snapshots.size,
    });
    const rootPath = engine.ompSessionFile;
    const rootSessionId = (rootPath ? ompSessionIdOfFilePath(rootPath) : null) ?? engine.sessionId;
    const directory = engine.projection?.subagentDirectory(0, 256);
    const processHost = engine.subagentProcessHost?.();
    const currentProcess = processHost?.currentProcess() ?? null;
    if (state.sourceProcess !== currentProcess) {
      const previousProcessPresent = state.sourceProcess != null;
      state.sourceProcess = currentProcess;
      state.processRevision += 1;
      diagnostics.debug("omp.agent_interactions.process_fence.changed", {
        sessionId: engine.sessionId,
        processRevision: state.processRevision,
        previousProcessPresent,
        processPresent: currentProcess !== null,
      });
    }
    const issues = new Set<Issue>(["legacy_history_gaps"]);
    if (engine.agentInteractions.truncated) issues.add("read_budget_exceeded");
    if (state.liveRevision !== engine.agentInteractions.revision) {
      state.liveRevision = engine.agentInteractions.revision;
      state.liveSources = engine.agentInteractions.sources();
    }
    const live = state.liveSources ?? [];
    const history: InteractionSource[] = [];
    const children = new Map<string, InteractionChild>();
    const versions: string[] = [
      rootPath ?? "",
      String(engine.agentInteractions.revision),
      String(directory?.revision ?? 0),
      String(state.processRevision),
    ];
    const queue: { id: string; ancestry: string[] }[] = [{ id: "main", ancestry: [] }];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const owner = queue[index]!;
      if (visited.has(owner.id)) continue;
      if (visited.size >= 256 || owner.ancestry.length > 8) {
        issues.add("read_budget_exceeded");
        continue;
      }
      visited.add(owner.id);
      let entries: unknown[] = [];
      if (rootPath) {
        const file = await this.readFile(state, rootPath, owner.ancestry);
        versions.push(`${owner.id}:${file.version}`);
        if (!file.available) issues.add("record_unavailable");
        if (file.truncated) issues.add("read_budget_exceeded");
        entries = file.entries;
      }
      const source: InteractionSource = {
        agentId: owner.id,
        source: "history",
        key: `history:${owner.id}`,
        entries,
      };
      history.push(source);
      const rawOwner = owner.ancestry.at(-1) ?? "$root";
      const ownedLive = live.filter((item) => item.agentId === rawOwner);
      // 父工具结果证明归属后才允许扫描后代；生命周期载荷路径不会成为文件读入口。
      for (const childSource of [
        source,
        ...ownedLive.map((item) => ({ ...item, agentId: owner.id })),
      ]) {
        const key = `${owner.id}:${childSource.key}`;
        const cached = state.childrenCache.get(key);
        const discovered =
          cached?.entries === childSource.entries
            ? cached.children
            : childrenFromInteractionRecords(childSource, owner.ancestry);
        state.childrenCache.set(key, { entries: childSource.entries, children: discovered });
        for (const child of discovered) {
          const prior = children.get(child.id);
          children.set(child.id, { ...prior, ...child });
          if (!visited.has(child.id)) queue.push({ id: child.id, ancestry: child.ancestry });
        }
      }
    }
    // 修复：自动送达的结果没有 wait.jobs；交互节点与执行页用同一子记录终态规则，
    // 不把 task.progress.pending 当成现在仍在执行，也不从最终正文猜测完成。
    for (const source of history) {
      const child = children.get(source.agentId);
      if (!child || source.entries.length === 0) continue;
      const outcome = ompHistoryOutcome(source.entries);
      if (
        terminalStatuses.has(child.status ?? "") &&
        (outcome.at === undefined || (child.statusAt !== undefined && outcome.at < child.statusAt))
      )
        continue;
      children.set(child.id, { ...child, status: outcome.status, statusAt: outcome.at });
    }
    const observedStatuses = new Map<string, string | undefined>();
    for (const child of children.values()) {
      const status = processHost?.observedSubagentStatus?.(child.rawId, currentProcess);
      observedStatuses.set(child.id, status);
      // 首次实核证明可能与旧行字段完全相同，目录 revision 不变；证明本身也参与缓存键。
      versions.push(`${child.id}:${status ?? "unknown"}`);
    }
    const signature = versions.join("\0");
    const previous = state.snapshots.get(state.revision);
    if (previous && state.signature === signature) {
      diagnostics.debug("omp.agent_interactions.refresh.reused", {
        sessionId: engine.sessionId,
        revision: previous.revision,
        totalEventCount: previous.totalEvents,
        coverageStatus: previous.coverage.status,
        coverageIssues: previous.coverage.issues,
      });
      return previous;
    }
    const snapshot = buildInteractionSnapshot({
      rootSessionId,
      revision: state.revision + 1,
      children,
      observedStatuses,
      terminalStatuses,
      directory,
      history,
      live,
      issues,
    });
    state.signature = signature;
    state.revision = snapshot.revision;
    state.snapshots.set(snapshot.revision, snapshot);
    while (state.snapshots.size > 2) state.snapshots.delete(state.snapshots.keys().next().value!);
    diagnostics.debug("omp.agent_interactions.refresh.completed", {
      sessionId: engine.sessionId,
      revision: snapshot.revision,
      agentCount: snapshot.agents.length,
      historySourceCount: history.length,
      liveSourceCount: live.length,
      totalEventCount: snapshot.totalEvents,
      coverageStatus: snapshot.coverage.status,
      coverageIssues: snapshot.coverage.issues,
      elapsedMs: Date.now() - refreshStartedAt,
    });
    return snapshot;
  }
}
