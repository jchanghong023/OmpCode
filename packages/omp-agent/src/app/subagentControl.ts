// 子代理控制（omp-core-integration.md）：stop → omp cancel_subagent、send_message →
// omp steer_subagent，均在父会话自己的进程上执行（上游 v1 面；新核仅运行中子代理可达，
// 未运行/未知 id 的取消按成功 no-op、发送按错误文案返回——oh-my-pi rpc-mode.ts
// handleRpcCancelSubagent/handleRpcSteerSubagent 语义）。
// 只读详情的记录续读（get_subagent_messages fromByte/nextByte）同经父会话进程。

import type { OmpCommandOutcome, OmpSessionProcess } from "./ports.js";
import { diagnostics } from "./diagnostics.js";

/** 引擎侧控制/续读所需的最小面（ConversationEngine 的结构化窄视图，避免反向依赖成环）。 */
export interface EngineSubagentHost {
  ensureStarted(): Promise<void>;
  currentProcess(): OmpSessionProcess | null;
}

/** 控制入口的引擎定位面（SessionRegistry 的窄视图）。 */
export interface SubagentControlDeps {
  getEngine(sessionId: string): EngineSubagentHost | null;
}

/**
 * 控制子代理：返回 omp 结果（success/error/data）。进程不存在按可重试失败返回；
 * 启动失败按 omp_start_failed 收口（控制是显式用户动作，允许现场拉起惰性进程）。
 */
export async function controlSubagent(
  deps: SubagentControlDeps,
  sessionId: string,
  subagentId: string,
  action: "send_message" | "stop",
  message?: string,
): Promise<OmpCommandOutcome> {
  return diagnostics.run(
    { sessionId, parentSessionId: sessionId, subagentId, action },
    async () => {
      const startedAt = Date.now();
      diagnostics.info("omp.subagent.control.started");
      let stage = "locate_session";
      const failed = (outcome: OmpCommandOutcome, cause?: unknown): OmpCommandOutcome => {
        diagnostics.error("omp.subagent.control.failed", {
          stage,
          resultStatus: "failed",
          code: outcome.code,
          errorType:
            cause === undefined ? undefined : cause instanceof Error ? cause.name : typeof cause,
          elapsedMs: Date.now() - startedAt,
        });
        return outcome;
      };
      const engine = deps.getEngine(sessionId);
      if (!engine) return failed({ success: false, error: `session unavailable: ${sessionId}` });
      stage = "start";
      try {
        await engine.ensureStarted();
      } catch (error) {
        return failed(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            code: "omp_start_failed",
          },
          error,
        );
      }
      stage = "locate_process";
      const process = engine.currentProcess();
      if (!process)
        return failed({
          success: false,
          error: "omp core failed to start",
          code: "omp_start_failed",
        });
      stage =
        action === "send_message" && (message === undefined || message.length === 0)
          ? "validate_message"
          : "send";
      try {
        const outcome = await sendSubagentControl(process, subagentId, action, message);
        if (!outcome.success) {
          if (stage === "send") stage = "peer_failure";
          return failed(outcome);
        }
        diagnostics.info("omp.subagent.control.result", {
          stage: "response",
          resultStatus: action === "stop" ? "stopping" : "sent",
          elapsedMs: Date.now() - startedAt,
        });
        return outcome;
      } catch (error) {
        // 控制 reject 仍交给原调用者，日志不得把异常伪装成 success 或返回式 failure。
        diagnostics.error("omp.subagent.control.failed", {
          stage: "send_rejected",
          resultStatus: "rejected",
          errorType: error instanceof Error ? error.name : typeof error,
          elapsedMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  );
}

/**
 * 会话引擎的控制转发：stop → cancel_subagent（响应 {cancelled:boolean}——未知/已结束
 * 子代理按成功 no-op）；send_message → steer_subagent（响应无 data；错误以 error 文案
 * 返回，如 "Subagent not running: <id>"）。状态词对齐上游真值（cancelled/stopping 语义
 * 由上游消息承载），适配器不伪造同步完成。
 */
async function sendSubagentControl(
  process: OmpSessionProcess,
  subagentId: string,
  action: "send_message" | "stop",
  message?: string,
): Promise<OmpCommandOutcome> {
  if (action === "stop") {
    const outcome = await process.send({ type: "cancel_subagent", subagentId });
    return outcome.success
      ? { success: true, data: { subagentId, action, status: "stopping" } }
      : outcome;
  }
  if (message === undefined || message.length === 0) {
    return { success: false, error: "send_message requires a message", code: "invalid_params" };
  }
  const outcome = await process.send({ type: "steer_subagent", subagentId, message });
  return outcome.success
    ? { success: true, data: { subagentId, action, status: "sent" } }
    : outcome;
}

/**
 * 子代理只读详情的记录续读（get_subagent_messages）：进程就绪失败返回 null（视图侧按
 * 传输层异常处理——保持当前内容，不插「记录不可用」提示行）。
 */
export async function readSubagentRecord(
  host: EngineSubagentHost,
  subagentId: string,
  fromByte?: number,
): Promise<OmpCommandOutcome | null> {
  const startedAt = Date.now();
  const fields = { subagentId, fromByte: fromByte ?? 0 };
  diagnostics.debug("omp.subagent.read.started", fields);
  const failed = (stage: string, error?: unknown): null => {
    diagnostics.warn("omp.subagent.read.failed", {
      ...fields,
      stage,
      errorType: error instanceof Error ? error.name : typeof error,
      elapsedMs: Date.now() - startedAt,
    });
    return null;
  };
  try {
    await host.ensureStarted();
  } catch (error) {
    return failed("start", error);
  }
  const process = host.currentProcess();
  if (!process) return failed("locate_process");
  return process
    .send({
      type: "get_subagent_messages",
      subagentId,
      ...(fromByte !== undefined ? { fromByte } : {}),
    })
    .then((outcome) => {
      if (!outcome.success)
        diagnostics.warn("omp.subagent.read.failed", {
          ...fields,
          stage: "peer_failure",
          code: outcome.code,
          elapsedMs: Date.now() - startedAt,
        });
      else {
        const data =
          typeof outcome.data === "object" && outcome.data !== null
            ? (outcome.data as { entries?: unknown; nextByte?: unknown; reset?: unknown })
            : {};
        diagnostics.debug("omp.subagent.read.result", {
          ...fields,
          stage: "response",
          entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
          nextByte: typeof data.nextByte === "number" ? data.nextByte : undefined,
          reset: data.reset === true,
          elapsedMs: Date.now() - startedAt,
        });
      }
      return outcome;
    })
    .catch((error: unknown) => failed("send_rejected", error));
}
