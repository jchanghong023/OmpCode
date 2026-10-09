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
  viewIdOf: (id: string) => string = (id) => `omp-subagent:${id}`,
  limit = 20,
) {
  const ended = [...statuses.entries()].filter(([, status]) => status !== "running");
  const items = ended.slice(offset, offset + limit).flatMap(([id, status]) => {
    const row = rowAt(rowIds.get(id) ?? -1);
    if (row?.kind !== "subagent" || status === "running") return [];
    return [
      {
        childSessionId: viewIdOf(id),
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
      ...(offset + limit < ended.length ? { nextCursor: String(offset + limit) } : {}),
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
  parentToolCallId?: string;
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
      /** 子代理只读详情的 UI 地址（含父会话归属；entityId 仍为 `omp-subagent:<id>`）。 */
      viewIdOf: (id: string) => string;
    },
  ) {}

  setAvailability(availability: "ready" | "unavailable"): void {
    const state = this.host.state();
    if (state.availability === availability) return;
    this.host.patchState({ ...state, availability, revision: state.revision + 1 });
  }

  /** 冷历史与实时行使用同一父会话地址，复用 ZCode 原有详情入口。 */
  withViewId(row: ConversationRow): ConversationRow {
    if (row.kind !== "subagent" || !row.entityId?.startsWith("omp-subagent:")) return row;
    return {
      ...row,
      childSessionId: this.host.viewIdOf(row.entityId.slice("omp-subagent:".length)),
    };
  }

  hydrate(rows: readonly ConversationRow[]): SubagentProjectionState {
    this.rowIds.clear();
    this.statuses.clear();
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
            childSessionId: this.host.viewIdOf(id),
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
      childSessionIds: [...this.statuses.keys()].map((id) => this.host.viewIdOf(id)),
      running,
      endedTotal: [...this.statuses.values()].filter((status) => status !== "running").length,
    };
  }

  upsert(input: SubagentInput): void {
    const rowId = this.rowIds.get(input.id);
    const prior = rowId === undefined ? null : this.host.rowAt(rowId);
    const parentToolCallId =
      input.parentToolCallId ?? (prior?.kind === "subagent" ? prior.parentToolCallId : undefined);
    if (
      prior?.kind === "subagent" &&
      prior.status === input.status &&
      prior.summaryText === input.summaryText &&
      prior.parentToolCallId === parentToolCallId &&
      prior.transcriptText === input.transcriptText
    )
      return;
    const turn = prior ?? this.host.turnAnchor();
    if (turn) {
      const nextRowId = rowId ?? this.host.nextRowId();
      const row: SubagentRow = {
        rowId: nextRowId,
        // 修复：后台代理跨轮完成时仍归属启动轮，不能把旧卡片挪进当前用户轮。
        turnId: prior?.turnId ?? turn.turnId,
        productTurnId: prior?.productTurnId ?? turn.productTurnId,
        entityId: `omp-subagent:${input.id}`,
        kind: "subagent",
        // 修复：目录已有可订阅地址，但主对话行缺失，导致只显示摘要而无法打开 Agent 卡片。
        childSessionId: this.host.viewIdOf(input.id),
        ...(parentToolCallId ? { parentToolCallId } : {}),
        subagentType: input.agent,
        status: input.status,
        summaryText: input.summaryText,
        ...(input.transcriptText ? { transcriptText: input.transcriptText } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.status !== "running" && input.status !== "unknown"
          ? { endedAt: Date.now() }
          : {}),
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
          childSessionId: this.host.viewIdOf(id),
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
      childSessionIds: [...this.statuses.keys()].map((id) => this.host.viewIdOf(id)),
      running,
      endedTotal: [...this.statuses.values()].filter((status) => status !== "running").length,
    });
  }

  directory(offset: number, limit = 20) {
    return buildOmpSubagentDirectory(
      this.statuses,
      this.rowIds,
      this.host.rowAt,
      this.host.state(),
      offset,
      this.host.viewIdOf,
      limit,
    );
  }
}
