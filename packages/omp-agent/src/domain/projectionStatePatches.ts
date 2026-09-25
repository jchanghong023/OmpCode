// A 区状态的纯 patch 构造器（键级整体替换）。从 conversationProjection 拆出
// （架构 maxFileLines=400）；输入旧状态，输出新键值，不改状态机本身。

import type { SessionConfigState, StatePatch } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionAState, TurnOutcome } from "./projectionTypes.js";
import type { OmpContextReport } from "./ompContextReport.js";

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
export function terminalControlPatch(state: ProjectionAState, outcome: TurnOutcome, error?: { code: string; message: string }): StatePatch {
  const phase = outcome === "success" ? "completedSuccess" : outcome === "interrupted" ? "completedInterrupted" : "error";
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
  delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
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

export function contextWindowPatch(state: ProjectionAState, usedTokens: number | null, maxTokens: number | null, report?: OmpContextReport | null): StatePatch {
  return {
    usage: {
      ...state.usage,
      contextWindow:
        usedTokens !== null && maxTokens !== null && maxTokens > 0
          ? { usedTokens, maxTokens, autoCompactThresholdTokens: null,
              ...(report?.contextWindow === maxTokens ? { details: { entries: report.entries } } : {}) }
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
      ...(config.autoCompactionEnabled !== undefined ? { autoCompactionEnabled: config.autoCompactionEnabled } : {}),
    },
  };
}
