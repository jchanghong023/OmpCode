import type {
  ZCodeAgentInteractionAgent,
  ZCodeAgentInteractionCoverage,
  ZCodeSessionAgentInteractionsResult,
  ZCodeSessionSubagentsResult,
} from "@zcode/shared";
import {
  observationsFromInteractionRecords,
  interactionChildId,
  type InteractionChild,
  type InteractionSource,
} from "./OmpAgentInteractionRecords.js";
import { mergeInteractionObservations } from "./OmpAgentInteractionMerge.js";
import { buildOmpSubagentViewId } from "./ompViewIds.js";

type Issue = ZCodeAgentInteractionCoverage["issues"][number];
interface InteractionSnapshotInput {
  rootSessionId: string;
  revision: number;
  children: ReadonlyMap<string, InteractionChild>;
  observedStatuses: ReadonlyMap<string, string | undefined>;
  terminalStatuses: ReadonlySet<string>;
  directory: Pick<ZCodeSessionSubagentsResult, "running" | "ended"> | undefined;
  history: readonly InteractionSource[];
  live: readonly InteractionSource[];
  issues: Set<Issue>;
}

/** 将已采集的事实组装为快照；缓存、历史终态决策与进程观察仍由 Store 唯一持有，避免派生读面成为第二个状态 owner。 */
export function buildInteractionSnapshot({
  rootSessionId,
  revision,
  children,
  observedStatuses,
  terminalStatuses,
  directory,
  history,
  live,
  issues,
}: InteractionSnapshotInput): ZCodeSessionAgentInteractionsResult {
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
  return {
    rootSessionId,
    revision,
    agents: [...agents.values()],
    events,
    coverage: { status: issues.size ? "partial" : "complete", issues: [...issues].sort() },
    totalEvents: events.length,
  };
}
