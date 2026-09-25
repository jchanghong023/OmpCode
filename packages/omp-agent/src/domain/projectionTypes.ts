// 会话投影的 A 区状态与行构造默认值。schema 校验以 @zcode/shared 的
// zcode-protocol-v4 为准；这里只负责产出合法载荷，不重复声明协议约束。

import type {
  ConversationRow,
  SubagentProjectionState,
  SessionActionAvailability,
  SessionConfigState,
  SessionControl,
  SessionUsageState,
  QueueState,
} from "@zcode/shared/zcode-protocol-v4";

export type TurnOutcome = "success" | "interrupted" | "failed";

export interface ProjectionAState {
  control: SessionControl;
  availability: SessionActionAvailability;
  inputRouting: { mode: "startNow" | "enqueue" | "guide" | "reject" | "choice"; reasonCode?: string };
  meta: { title: string; titleSource: "default" | "generated" | "custom" };
  config: SessionConfigState;
  modelTransition: null;
  usage: SessionUsageState;
  queue: QueueState;
  pendingInteractions: import("@zcode/shared/zcode-protocol-v4").PendingInteraction[];
  pendingCommands: import("@zcode/shared/zcode-protocol-v4").CommandStateSummary[];
  backgroundWorks: import("@zcode/shared/zcode-protocol-v4").BackgroundWorkSummary[];
  subagents: SubagentProjectionState;
  goal: null;
  plan: null;
  workspaceHookAdmission: null;
}

export function emptyUsage(): SessionUsageState {
  return {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** omp 核心当前无法等价提供的动作，用稳定的 guard id 呈现禁用态（同步 FORK.md 已知差异）。 */
export const OMP_UNSUPPORTED_GUARD = "fault.command.unsupportedByOmpCore";

export function defaultAvailability(): SessionActionAvailability {
  return {
    fork: { allowed: false, reasonCode: OMP_UNSUPPORTED_GUARD },
    compact: { allowed: true },
    switchModelConfig: { allowed: true },
    setFollowupMode: { allowed: true },
    queueEdit: { allowed: false, reasonCode: OMP_UNSUPPORTED_GUARD },
    sendQueuedNow: { allowed: false, reasonCode: OMP_UNSUPPORTED_GUARD },
    pauseGoal: { allowed: false, reasonCode: OMP_UNSUPPORTED_GUARD },
    resumeGoal: { allowed: false, reasonCode: OMP_UNSUPPORTED_GUARD },
  };
}

export function initialAState(config: Partial<SessionConfigState>): ProjectionAState {
  return {
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: defaultAvailability(),
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: config.provider ?? "",
      model: config.model ?? "",
      thought: config.thought ?? "",
      thoughtLevels: config.thoughtLevels ?? [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: emptyUsage(),
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
  };
}

// ── 行基础字段 ──
export interface RowBaseInit {
  rowId: number;
  turnId: string;
  entityId: string;
  productTurnId: string;
  createdAtSeq: number;
}

export function rowBaseFields(init: RowBaseInit) {
  return {
    rowId: init.rowId,
    turnId: init.turnId,
    entityId: init.entityId,
    productTurnId: init.productTurnId,
    createdAt: Date.now(),
    createdAtSeq: init.createdAtSeq,
  };
}

export type { ConversationRow };
