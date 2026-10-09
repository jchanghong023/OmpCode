import {
  ompHistoricalStatus,
  ompHistoryOutcome,
  type OmpHistoryStatus,
} from "./OmpSubagentHistory.js";

interface ColdSubagent {
  id: string;
  agent: string;
  summary: string;
  status: OmpHistoryStatus;
  parentToolCallId: string;
  startedAt: number;
  endedAt?: number;
  resultText?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function coldSubagents(
  entries: readonly unknown[],
  childRecords: ReadonlyMap<string, readonly unknown[]> = new Map(),
): Map<string, ColdSubagent> {
  const agents = new Map<string, ColdSubagent>();
  for (const entry of entries) {
    const message = object(object(entry)?.message);
    if (message?.role !== "toolResult") continue;
    const details = object(message.details);
    if (message.toolName === "task" && typeof message.toolCallId === "string") {
      for (const raw of Array.isArray(details?.progress) ? details.progress : []) {
        const progress = object(raw);
        if (!progress || typeof progress.id !== "string" || !progress.id) continue;
        agents.set(progress.id, {
          id: progress.id,
          agent: typeof progress.agent === "string" ? progress.agent : "task",
          summary: (typeof progress.description === "string"
            ? progress.description
            : typeof progress.assignment === "string"
              ? progress.assignment
              : typeof progress.task === "string"
                ? progress.task
                : progress.id
          )
            .replace(/\s+/g, " ")
            .slice(0, 180),
          status: ompHistoricalStatus(progress.status),
          parentToolCallId: message.toolCallId,
          startedAt:
            typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now(),
        });
      }
    }
    if (message.toolName === "wait") {
      for (const raw of Array.isArray(details?.jobs) ? details.jobs : []) {
        const job = object(raw);
        if (!job || (job.type !== undefined && job.type !== "task")) continue;
        const id = typeof job.agentUrlId === "string" ? job.agentUrlId : job.id;
        if (typeof id !== "string") continue;
        const prior = agents.get(id);
        if (!prior) continue;
        prior.status = ompHistoricalStatus(job.status);
        if (prior.status !== "unknown")
          prior.endedAt =
            typeof message.timestamp === "number" ? Math.trunc(message.timestamp) : Date.now();
        if (typeof job.resultText === "string") prior.resultText = job.resultText;
      }
    }
  }
  // 修复：后台自动送达不一定产生 wait.jobs；从已验证归属的子记录核对最新终态，
  // 不能让 A/C 的旧 task.pending 在冷恢复时变回 running，也不能覆盖更新的父结果。
  for (const agent of agents.values()) {
    const records = childRecords.get(agent.id);
    if (!records?.length) continue;
    const outcome = ompHistoryOutcome(records);
    if (agent.endedAt !== undefined && outcome.at !== undefined && outcome.at < agent.endedAt)
      continue;
    agent.status = outcome.status;
    agent.endedAt = outcome.status === "unknown" ? undefined : outcome.at;
  }
  return agents;
}
