import type {
  SessionConfigState,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";
import type { OmpBtwRecord } from "./OmpBtwFrames.js";

// 将 BTW record 的状态映射与 Store 的 RPC/发布职责分开；这里只计算 patch，
// 不持有投影或历史。错误时间由 Store 在原投影时点提供，非错误状态不读取时间。
export function btwProjectionStatePatch(
  control: SessionControl,
  latest: Pick<OmpBtwRecord, "status" | "error">,
  errorAt: number,
  config?: SessionConfigState,
): Pick<StatePatch, "control" | "inputRouting" | "config"> {
  const running = latest.status === "running";
  return {
    ...(config ? { config } : {}),
    control: {
      ...control,
      phase: running
        ? "running"
        : latest.status === "complete"
          ? "completedSuccess"
          : latest.status === "error"
            ? "error"
            : "completedInterrupted",
      canStop: running,
      stopState: running ? "stoppable" : "idle",
      stopTargetKind: "assistant",
      sessionEnded: !running,
      lastError:
        latest.status === "error" || latest.status === "interrupted"
          ? {
              code: `side_${latest.status}`,
              message: latest.error ?? latest.status,
              recoverable: true,
              at: errorAt,
              source: "runtime",
            }
          : null,
    },
    inputRouting: running
      ? { mode: "reject", reasonCode: "fault.command.sideSessionRunning" }
      : { mode: "startNow" },
  };
}
