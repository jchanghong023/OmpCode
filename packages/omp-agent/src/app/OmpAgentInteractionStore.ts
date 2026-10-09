import type {
  ZCodeAgentInteractionAgent,
  ZCodeAgentInteractionCoverage,
  ZCodeSessionAgentInteractionsResult,
} from "@zcode/shared";
import {
  childrenFromInteractionRecords,
  observationsFromInteractionRecords,
  interactionChildId,
  type InteractionChild,
  type InteractionSource,
} from "../domain/OmpAgentInteractionRecords.js";
import { mergeInteractionObservations } from "../domain/OmpAgentInteractionMerge.js";
import { buildOmpSubagentViewId } from "../domain/ompViewIds.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";
import { ProtocolError } from "./errors.js";
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
    let snapshot: Snapshot;
    let offset = 0;
    if (cursor) {
      const match = /^(\d+):(\d+)$/.exec(cursor);
      if (!match) throw new ProtocolError(-32602, "invalid agent interaction cursor");
      const stored = state.snapshots.get(Number(match[1]));
      if (!stored)
        throw new ProtocolError(-32009, "agent interaction snapshot expired; restart query");
      snapshot = stored;
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset > snapshot.totalEvents)
        throw new ProtocolError(-32602, "invalid agent interaction cursor");
    } else {
      const target = state;
      if (!target.loading)
        target.loading = this.refresh(engine, target).finally(() => {
          target.loading = undefined;
        });
      snapshot = await target.loading;
    }
    if (!isCurrent())
      throw new ProtocolError(-32004, "agent interaction session changed during read");
    const end = Math.min(offset + limit, snapshot.totalEvents);
    return {
      ...snapshot,
      events: snapshot.events.slice(offset, end),
      ...(end < snapshot.totalEvents ? { nextCursor: `${snapshot.revision}:${end}` } : {}),
    };
  }

  private async readFile(
    state: State,
    path: string,
    ancestry: readonly string[],
  ): Promise<CachedFile> {
    const key = `${path}\0${ancestry.join("/")}`;
    const prior = state.files.get(key);
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
      state.files.set(key, result);
      return result;
    }
    const entries =
      ancestry.length === 0
        ? await this.store.readSessionEntries(path)
        : ancestry.length === 1
          ? await this.store.readSubagentEntries(path, ancestry[0]!)
          : [];
    // 兼容测试端口只承担已有直接子代理入口；生产端口提供逐级受控后代读取。
    return {
      version: JSON.stringify(entries),
      entries,
      available: entries.length > 0,
      truncated: false,
    };
  }

  private async refresh(engine: ConversationEngine, state: State): Promise<Snapshot> {
    const rootPath = engine.ompSessionFile;
    const rootSessionId = (rootPath ? ompSessionIdOfFilePath(rootPath) : null) ?? engine.sessionId;
    const directory = engine.projection?.subagentDirectory(0, 256);
    const processHost = engine.subagentProcessHost?.();
    const currentProcess = processHost?.currentProcess() ?? null;
    if (state.sourceProcess !== currentProcess) {
      state.sourceProcess = currentProcess;
      state.processRevision += 1;
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
    if (previous && state.signature === signature) return previous;
    const agents = new Map<string, ZCodeAgentInteractionAgent>([
      ["main", { id: "main", label: "main", known: true }],
    ]);
    const aliases = new Map<string, string[]>();
    for (const child of children.values()) {
      const { rawId, ancestry, statusAt: _statusAt, ...agent } = child;
      const observedStatus = observedStatuses.get(child.id);
      agents.set(agent.id, {
        ...agent,
        // 冷订阅可能仅启动 Main；只有同一进程观察到此 child 才能证明当前运行态。
        status:
          observedStatus ?? (terminalStatuses.has(agent.status ?? "") ? agent.status : "unknown"),
        ...(ancestry.length === 1
          ? { detailSessionId: buildOmpSubagentViewId(rootSessionId, rawId) }
          : {}),
      });
      aliases.set(rawId, [...(aliases.get(rawId) ?? []), agent.id]);
    }
    // 直接子代理状态复用既有会话投影 owner；不把旧 task.progress 快照当成当前运行态。
    for (const item of [...(directory?.running ?? []), ...(directory?.ended.items ?? [])]) {
      if (!item.agentId) continue;
      const agent = agents.get(interactionChildId("main", item.agentId));
      if (agent?.parentAgentId !== "main") continue;
      if (
        !terminalStatuses.has(agent.status ?? "") &&
        agent.status === "unknown" &&
        terminalStatuses.has(item.status)
      ) {
        agents.set(agent.id, { ...agent, status: item.status });
      }
    }
    const resolveAgent = (rawId: string): string => {
      if (rawId === "$root" || rawId === "Main") return "main";
      if (rawId === "main" && !aliases.has(rawId)) return "main";
      if (rawId.includes("/") && agents.has(rawId)) return rawId;
      const candidates = aliases.get(rawId) ?? [];
      if (candidates.length === 1) return candidates[0]!;
      const id = candidates.length > 1 ? `unknown:${rawId}` : rawId;
      if (candidates.length > 1) issues.add("ambiguous_identity");
      if (!agents.has(id)) agents.set(id, { id, label: rawId, known: false });
      return id;
    };
    const sources = [
      ...history,
      ...live.map((source) => ({ ...source, agentId: resolveAgent(source.agentId) })),
    ];
    const observations = sources.flatMap((source) =>
      observationsFromInteractionRecords(source, {
        resolveAgent,
        knownChild: (parentId, rawId) => {
          const id = interactionChildId(parentId, rawId);
          return children.has(id) ? id : undefined;
        },
      }),
    );
    const events = mergeInteractionObservations(observations, issues);
    const snapshot: Snapshot = {
      rootSessionId,
      revision: state.revision + 1,
      agents: [...agents.values()],
      events,
      coverage: { status: issues.size ? "partial" : "complete", issues: [...issues].sort() },
      totalEvents: events.length,
    };
    state.signature = signature;
    state.revision = snapshot.revision;
    state.snapshots.set(snapshot.revision, snapshot);
    while (state.snapshots.size > 2) state.snapshots.delete(state.snapshots.keys().next().value!);
    return snapshot;
  }
}
