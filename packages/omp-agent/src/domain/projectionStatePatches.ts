// A 区状态的纯 patch 构造器（键级整体替换）。从 conversationProjection 拆出
// （架构 maxFileLines=400）；输入旧状态，输出新键值，不改状态机本身。

import type {
  PendingInteraction,
  SessionConfigState,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionAState, TurnOutcome } from "./projectionTypes.js";
import type { OmpContextReport } from "./ompContextReport.js";

/** 等待交互也能停止；只派生停止可用性，不推断背景命令或模型轮的终态。 */
export function withInteractionStopControl(state: ProjectionAState, patch: StatePatch): StatePatch {
  if (!patch.control && !patch.pendingInteractions) return patch;
  const pending = patch.pendingInteractions ?? state.pendingInteractions;
  if (pending.length === 0 && state.pendingInteractions.length === 0) return patch;
  const control = patch.control ?? state.control;
  const running = control.phase === "running";
  const stopState =
    pending.length > 0
      ? control.stopState === "stopping"
        ? "stopping"
        : "stoppable"
      : running
        ? control.stopState
        : "idle";
  const canStop = pending.length > 0 ? stopState !== "stopping" : running ? control.canStop : false;
  if (canStop === control.canStop && stopState === control.stopState) return patch;
  return { ...patch, control: { ...control, canStop, stopState } };
}

/** AskUserQuestion 首次交互暂停倒计时：autoResolution 置 snoozed；未登记或已暂停返回 null。 */
export function snoozePendingInteractions(
  interactions: PendingInteraction[],
  interactionId: string,
): PendingInteraction[] | null {
  const current = interactions.find((item) => item.interactionId === interactionId);
  if (!current?.autoResolution || current.autoResolution.state === "snoozed") {
    return null;
  }
  const next: PendingInteraction = {
    ...current,
    autoResolution: {
      state: "snoozed",
      startedAt: current.autoResolution.startedAt,
      snoozedAt: Date.now(),
    },
  };
  return interactions.map((item) => (item.interactionId === interactionId ? next : item));
}

export function runningControlPatch(): StatePatch {
  return {
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "unknown",
      activeWorks: [{ kind: "primaryTurn", startedAt: Date.now() }],
      lastError: null,
      apiRetry: null,
    },
    inputRouting: { mode: "enqueue" },
  };
}

/** 轮终态：control phase 收口 + lastError + 输入路由复位（queue 清空）。 */
export function terminalControlPatch(
  state: ProjectionAState,
  outcome: TurnOutcome,
  error?: { code: string; message: string },
): StatePatch {
  const phase =
    outcome === "success"
      ? "completedSuccess"
      : outcome === "interrupted"
        ? "completedInterrupted"
        : "error";
  return {
    control: {
      phase,
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError:
        outcome === "failed"
          ? {
              code: error?.code ?? "runtime",
              message: error?.message ?? "turn failed",
              recoverable: true,
              at: Date.now(),
              source: "runtime",
            }
          : null,
      apiRetry: null,
    },
    inputRouting: { mode: "startNow" },
    queue: { items: [], autoDrain: state.queue.autoDrain },
  };
}

export function usagePatch(
  state: ProjectionAState,
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): StatePatch {
  const cumulative = state.usage.cumulative;
  return {
    usage: {
      ...state.usage,
      cumulative: {
        inputTokens: cumulative.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: cumulative.outputTokens + (delta.outputTokens ?? 0),
        cacheReadTokens: cumulative.cacheReadTokens + (delta.cacheReadTokens ?? 0),
        cacheWriteTokens: cumulative.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
      },
    },
  };
}

export function contextWindowPatch(
  state: ProjectionAState,
  usedTokens: number | null,
  maxTokens: number | null,
  report?: OmpContextReport | null,
): StatePatch {
  return {
    usage: {
      ...state.usage,
      contextWindow:
        usedTokens !== null && maxTokens !== null && maxTokens > 0
          ? {
              usedTokens,
              maxTokens,
              autoCompactThresholdTokens: null,
              ...(report?.contextWindow === maxTokens
                ? { details: { entries: report.entries } }
                : {}),
            }
          : null,
    },
  };
}

export function modelConfigPatch(
  state: ProjectionAState,
  config: {
    provider?: string;
    model?: string;
    thought?: string;
    thoughtLevels?: string[];
    followupMode?: SessionConfigState["followupMode"];
    autoCompactionEnabled?: boolean;
  },
): StatePatch {
  return {
    config: {
      ...state.config,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.thought !== undefined ? { thought: config.thought } : {}),
      ...(config.thoughtLevels !== undefined ? { thoughtLevels: config.thoughtLevels } : {}),
      ...(config.followupMode !== undefined ? { followupMode: config.followupMode } : {}),
      ...(config.autoCompactionEnabled !== undefined
        ? { autoCompactionEnabled: config.autoCompactionEnabled }
        : {}),
    },
  };
}
