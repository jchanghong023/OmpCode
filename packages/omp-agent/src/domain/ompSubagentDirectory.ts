import type {
  ConversationRow,
  SubagentProjectionState,
  SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";

/** legacy 子代理目录只读页；同一父会话投影的状态与行是唯一事实源。 */
export function buildOmpSubagentDirectory(
  statuses: ReadonlyMap<string, SubagentRow["status"]>,
  rowIds: ReadonlyMap<string, number>,
  rowAt: (rowId: number) => ConversationRow | undefined,
  state: SubagentProjectionState,
  offset: number,
) {
  const ended = [...statuses.entries()].filter(([, status]) => status !== "running");
  const items = ended.slice(offset, offset + 20).flatMap(([id, status]) => {
    const row = rowAt(rowIds.get(id) ?? -1);
    if (row?.kind !== "subagent" || status === "running") return [];
    return [
      {
        childSessionId: `omp-subagent:${id}`,
        agentId: id,
        subagentType: row.subagentType,
        title: row.summaryText || row.subagentType,
        summary: row.transcriptText?.slice(0, 200) ?? "",
        status,
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        ...(row.endedAt ? { endedAt: row.endedAt } : {}),
      },
    ];
  });
  return {
    revision: state.revision,
    childSessionIds: state.childSessionIds,
    running: state.running,
    ended: {
      total: ended.length,
      items,
      ...(offset + 20 < ended.length ? { nextCursor: String(offset + 20) } : {}),
    },
  };
}

type SubagentInput = {
  id: string;
  agent: string;
  status: SubagentRow["status"];
  summaryText: string;
  startedAt?: number;
  transcriptText?: string;
};

/** 子代理行 ID 与状态的单一 owner；父 ConversationProjection 提供行/状态写入出口。 */
export class OmpSubagentProjection {
  private readonly rowIds = new Map<string, number>();
  private readonly statuses = new Map<string, SubagentRow["status"]>();

  constructor(
    private readonly host: {
      rowAt: (id: number) => ConversationRow | undefined;
      turnAnchor: () => { turnId: string; productTurnId: string } | null;
      nextRowId: () => number;
      sequence: () => number;
      state: () => SubagentProjectionState;
      upsertRow: (row: SubagentRow) => void;
      patchState: (state: SubagentProjectionState) => void;
    },
  ) {}

  setAvailability(availability: "ready" | "unavailable"): void {
    const state = this.host.state();
    if (state.availability === availability) return;
    this.host.patchState({ ...state, availability, revision: state.revision + 1 });
  }

  hydrate(rows: readonly ConversationRow[]): SubagentProjectionState {
    for (const row of rows) {
      if (row.kind !== "subagent" || !row.entityId) continue;
      const id = row.entityId.startsWith("omp-subagent:")
        ? row.entityId.slice("omp-subagent:".length)
        : row.entityId;
      this.rowIds.set(id, row.rowId);
      this.statuses.set(id, row.status);
    }
    const running = [...this.statuses.entries()]
      .filter(([, status]) => status === "running")
      .flatMap(([id]) => {
        const row = this.host.rowAt(this.rowIds.get(id) ?? -1);
        if (row?.kind !== "subagent") return [];
        return [
          {
            childSessionId: `omp-subagent:${id}`,
            agentId: id,
            subagentType: row.subagentType,
            title: row.summaryText,
            status: "running" as const,
            ...(row.startedAt ? { startedAt: row.startedAt } : {}),
          },
        ];
      });
    return {
      revision: this.statuses.size > 0 ? 1 : 0,
      childSessionIds: [...this.statuses.keys()].map((id) => `omp-subagent:${id}`),
      running,
      endedTotal: [...this.statuses.values()].filter((status) => status !== "running").length,
    };
  }

  upsert(input: SubagentInput): void {
    const rowId = this.rowIds.get(input.id);
    const prior = rowId === undefined ? null : this.host.rowAt(rowId);
    if (
      prior?.kind === "subagent" &&
      prior.status === input.status &&
      prior.summaryText === input.summaryText &&
      prior.transcriptText === input.transcriptText
    )
      return;
    const turn = this.host.turnAnchor();
    if (turn) {
      const nextRowId = rowId ?? this.host.nextRowId();
      const row: SubagentRow = {
        rowId: nextRowId,
        turnId: turn.turnId,
        productTurnId: turn.productTurnId,
        entityId: `omp-subagent:${input.id}`,
        kind: "subagent",
        subagentType: input.agent,
        status: input.status,
        summaryText: input.summaryText,
        ...(input.transcriptText ? { transcriptText: input.transcriptText } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.status !== "running" ? { endedAt: Date.now() } : {}),
        createdAt: prior?.createdAt ?? Date.now(),
        createdAtSeq: prior?.createdAtSeq ?? this.host.sequence() + 1,
      };
      this.rowIds.set(input.id, nextRowId);
      this.host.upsertRow(row);
    }
    this.statuses.set(input.id, input.status);
    const running = [...this.statuses.entries()]
      .filter(([, status]) => status === "running")
      .map(([id]) => {
        const candidate = this.host.rowAt(this.rowIds.get(id) ?? -1);
        return {
          childSessionId: `omp-subagent:${id}`,
          agentId: id,
          subagentType: candidate?.kind === "subagent" ? candidate.subagentType : input.agent,
          title: candidate?.kind === "subagent" ? candidate.summaryText : input.summaryText,
          status: "running" as const,
          ...(candidate?.kind === "subagent" && candidate.startedAt
            ? { startedAt: candidate.startedAt }
            : {}),
        };
      });
    this.host.patchState({
      ...this.host.state(),
      revision: this.host.state().revision + 1,
      childSessionIds: [...this.statuses.keys()].map((id) => `omp-subagent:${id}`),
      running,
      endedTotal: [...this.statuses.values()].filter((status) => status !== "running").length,
    });
  }

  directory(offset: number) {
    return buildOmpSubagentDirectory(
      this.statuses,
      this.rowIds,
      this.host.rowAt,
      this.host.state(),
      offset,
    );
  }
}
