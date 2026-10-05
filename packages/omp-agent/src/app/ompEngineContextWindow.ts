// 引擎上下文窗口投影（自 ompEngineProcess.ts 拆出）：状态回读先行，异步 /context 仅在
// 同一进程、轮次和用量仍相符时补充估算分项。

import type { OmpContextReport } from "../domain/ompContextReport.js";
import type { OmpSessionProcess, OmpStateData } from "./ports.js";

/** /context 只补充估算分项；应用前由引擎再次核对会话、总量和轮次。 */
export function readEngineContextDetails(
  process: OmpSessionProcess,
  isCurrent: () => boolean,
  apply: (report: OmpContextReport) => void,
): void {
  void process
    .readContextReport()
    .then((report) => {
      if (report && isCurrent()) apply(report);
    })
    .catch(() => {});
}

/** 状态回读是完整窗口事实；异步 /context 仅在同一进程、轮次和用量仍相符时补充。 */
export function projectEngineContextWindow(input: {
  state: OmpStateData;
  projection: import("../domain/conversationProjection.js").ConversationProjection;
  process: OmpSessionProcess | null;
  isCurrentProcess: (process: OmpSessionProcess) => boolean;
  onReport: () => void;
}): void {
  const { state, projection, process } = input;
  if (!state.contextUsage || typeof state.contextUsage.contextWindow !== "number") return;
  const used = state.contextUsage.tokens ?? 0;
  const size = state.contextUsage.contextWindow;
  projection.setContextWindow(used, size);
  if (!process || projection.stateSnapshot.control.phase === "running") return;
  readEngineContextDetails(
    process,
    () =>
      input.isCurrentProcess(process) &&
      projection.stateSnapshot.control.phase !== "running" &&
      projection.stateSnapshot.usage.contextWindow?.usedTokens === used &&
      projection.stateSnapshot.usage.contextWindow?.maxTokens === size,
    (report) => {
      projection.setContextWindow(used, size, report);
      input.onReport();
    },
  );
}
