// 子代理控制（omp-core-integration.md）：stop → omp cancel_subagent、send_message →
// omp steer_subagent，均在父会话自己的进程上执行（上游 v1 面；新核仅运行中子代理可达，
// 未运行/未知 id 的原生取消虽为成功 no-op，适配器仍明确拒绝，只有 cancelled:true 才接纳；
// 发送失败保留原生错误（oh-my-pi rpc-mode.ts handleRpcCancelSubagent/handleRpcSteerSubagent）。
// 只读详情的记录续读（get_subagent_messages fromByte/nextByte）同经父会话进程。

import type { OmpCommandOutcome, OmpSessionProcess } from "./ports.js";
import { diagnostics } from "./diagnostics.js";

/** 引擎侧控制/续读所需的最小面（ConversationEngine 的结构化窄视图，避免反向依赖成环）。 */
export interface EngineSubagentHost {
  ensureStarted(): Promise<void>;
  currentProcess(): OmpSessionProcess | null;
  observedSubagentStatus?(id: string, process: OmpSessionProcess | null): string | undefined;
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
      const admittedProcess = engine.currentProcess();
      if (
        action === "stop" &&
        engine.observedSubagentStatus &&
        engine.observedSubagentStatus(subagentId, admittedProcess) !== "running"
      )
        return failed({
          success: false,
          error: "Subagent is not observed running",
          code: "not_running",
        });
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
      if (action === "stop" && admittedProcess && process !== admittedProcess)
        return failed({
          success: false,
          error: "Subagent process generation changed",
          code: "stale_process",
        });
      if (
        action === "stop" &&
        engine.observedSubagentStatus &&
        engine.observedSubagentStatus(subagentId, process) !== "running"
      )
        return failed({
          success: false,
          error: "Subagent is no longer running",
          code: "not_running",
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
 * 会话引擎的控制转发：stop → cancel_subagent，仅原生 {cancelled:true} 映射 stopping；
 * 未知/已结束的成功 no-op 明确失败。send_message → steer_subagent，原生错误原样返回。
 * 适配器不从 ACK 伪造完成，终态仍由原生生命周期与记录承载。
 */
async function sendSubagentControl(
  process: OmpSessionProcess,
  subagentId: string,
  action: "send_message" | "stop",
  message?: string,
): Promise<OmpCommandOutcome> {
  if (action === "stop") {
    const outcome = await process.send({ type: "cancel_subagent", subagentId });
    if (!outcome.success) return outcome;
    const data = outcome.data as { cancelled?: unknown } | undefined;
    if (data?.cancelled !== true)
      return {
        success: false,
        error: "OMP did not cancel a running subagent",
        code: "not_running",
      };
    return { success: true, data: { subagentId, action, status: "stopping" } };
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
