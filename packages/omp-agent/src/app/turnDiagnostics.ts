import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpSessionProcess } from "./ports.js";
import { diagnostics } from "./diagnostics.js";
import type { OmpSessionEventFrame } from "../domain/ompFrames.js";
import type { OmpEventProjector } from "../domain/ompProjector.js";

/** 只读现有投影，不保存另一份轮次/队列 owner；异步回调显式携带 session 身份。 */
export function turnContext(projection: ConversationProjection): Record<string, unknown> {
  return {
    sessionId: projection.sessionId,
    commandId: projection.activeTurnSourceCommandId(),
    phase: projection.stateSnapshot.control.phase,
  };
}

/** 终态必须来自实际 row 变更，不能把 ACK、agent_end 到达或无匹配轮当作完成。 */
export function logTurnTransitions(
  projection: ConversationProjection,
  beforeSeq: number,
  criterion: string,
): number {
  if (beforeSeq === projection.seq) return 0;
  const deltas = projection.deltasBetween(beforeSeq, projection.seq);
  if (!deltas) return 0;
  const logged = new Set<number>();
  for (const delta of deltas) {
    if (delta.op !== "row.upserted" && delta.op !== "row.appended") continue;
    const row = delta.row;
    if (row.kind !== "turnHeader" || row.state === "running" || logged.has(row.rowId)) continue;
    logged.add(row.rowId);
    const fields = {
      sessionId: projection.sessionId,
      commandId: row.sourceCommandId,
      turnId: row.turnId,
      state: row.state,
      executionKind: row.executionKind,
      criterion,
      elapsedMs: Math.max(0, (row.endedAt ?? Date.now()) - row.startedAt),
      failureStage: row.state === "failed" ? criterion : undefined,
    };
    if (row.state === "failed") diagnostics.error("omp.turn.terminal", fields);
    else if (row.state === "completedInterrupted") diagnostics.warn("omp.turn.terminal", fields);
    else diagnostics.info("omp.turn.terminal", fields);
  }
  return logged.size;
}

/** 只包围既有操作：保留返回值、抛错与回退，不新增超时、重试或结果对象副本。 */
export async function diagnosticOperation<T>(
  event: string,
  fields: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  diagnostics.info(`${event}.started`, fields);
  try {
    const result = await callback();
    const failed =
      result === false ||
      (typeof result === "object" &&
        result !== null &&
        (("error" in result && Boolean(result.error)) ||
          ("success" in result && result.success === false)));
    const summary = {
      ...fields,
      elapsedMs: Date.now() - startedAt,
      success: !failed,
      failureStage: failed ? "operation_result" : undefined,
      errorCode:
        failed &&
        typeof result === "object" &&
        result !== null &&
        "code" in result &&
        (typeof result.code === "string" || typeof result.code === "number")
          ? result.code
          : undefined,
    };
    if (failed) diagnostics.error(`${event}.failed`, summary);
    else diagnostics.info(`${event}.completed`, summary);
    return result;
  } catch (error) {
    diagnostics.error(`${event}.failed`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
      failureStage: "operation_exception",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

export async function readDiagnosticState(
  process: OmpSessionProcess,
  fields: Record<string, unknown>,
  event: string,
) {
  const startedAt = Date.now();
  diagnostics.debug(`${event}.started`, fields);
  try {
    const state = await diagnostics.run(fields, () => process.refreshState());
    if (state)
      diagnostics.debug(`${event}.completed`, {
        ...fields,
        elapsedMs: Date.now() - startedAt,
        statePresent: true,
      });
    else
      diagnostics.warn(`${event}.unavailable`, {
        ...fields,
        elapsedMs: Date.now() - startedAt,
        failureStage: "state_missing",
      });
    return state;
  } catch (error) {
    diagnostics.warn(`${event}.failed`, {
      ...fields,
      elapsedMs: Date.now() - startedAt,
      failureStage: "state_read",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}
export function diagnosticSessionCommand(
  process: OmpSessionProcess,
  command: Parameters<OmpSessionProcess["send"]>[0],
) {
  return diagnosticOperation(
    "omp.session.command",
    { ...diagnostics.context(), commandType: command.type },
    () => process.send(command),
  );
}

/** 事件回调只携带会话身份；旧实例回包仍由原 fence 判定，不能激活新 owner。 */
export function diagnosticFrameGuard(sessionId: unknown, isCurrent: () => boolean) {
  return <T>(type: string, callback: (frame: T) => unknown): ((frame: T) => void) =>
    (frame) => {
      if (isCurrent())
        diagnostics.run(
          {
            sessionId,
            requestId: undefined,
            commandId: undefined,
            inputId: undefined,
            traceId: undefined,
          },
          () => callback(frame),
        );
      else
        diagnostics.debug("omp.session.stale_frame", { sessionId, type, reason: "process_fence" });
    };
}

export function observeProjectedEvent(
  projection: ConversationProjection,
  event: OmpSessionEventFrame,
  projector: OmpEventProjector,
): void {
  const beforeSeq = projection.seq;
  const previousQueue = projection.stateSnapshot.queue.items;
  projector.handleEvent(event);
  if (event.type === "agent_end" && event.isTerminal !== false)
    logTurnTransitions(projection, beforeSeq, "agent_end");
  if (
    event.type !== "agent_start" &&
    !(event.type === "message_start" && event.message.role === "user")
  )
    return;
  const remaining = projection.stateSnapshot.queue.items;
  for (const input of previousQueue) {
    if (!remaining.some((item) => item.sourceCommandId === input.sourceCommandId))
      diagnostics.info("omp.queue.consumed", {
        sessionId: projection.sessionId,
        commandId: input.sourceCommandId,
        criterion: event.type,
        queueRemaining: remaining.length,
      });
  }
  diagnostics.debug("omp.turn.activity", { ...turnContext(projection), criterion: event.type });
}

function logDiagnosticFailure(
  event: string,
  fields: Record<string, unknown>,
  error: unknown,
  level: "warn" | "error" = "warn",
): void {
  diagnostics[level](event, {
    ...fields,
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

export function logSessionExit(
  projection: ConversationProjection,
  exitCode: number | null,
  resumePresent: boolean,
  streaming: boolean,
): void {
  diagnostics.error("omp.session.exited", {
    ...turnContext(projection),
    exitCode,
    resumePresent,
    queueCount: projection.stateSnapshot.queue.items.length,
    streaming,
    failureStage: "process_exit",
  });
}

export function logModelTransition(
  context: Record<string, unknown>,
  providerChanged: boolean,
  modelChanged: boolean,
): void {
  diagnostics.info("omp.model.changed", { ...context, providerChanged, modelChanged });
}

export function logStateIgnored(
  event: string,
  context: Record<string, unknown>,
  statePresent: boolean,
): void {
  diagnostics.debug(event, {
    ...context,
    statePresent,
    reason: statePresent ? "process_fence" : "state_missing",
  });
}

export function diagnosticSessionStart(
  resumePresent: boolean,
  callback: () => Promise<void>,
): Promise<void> {
  return diagnosticOperation("omp.session.start", { resumePresent }, callback);
}

export function logEngineFailure(
  event: string,
  error: unknown,
  failureStage: string,
  type?: string,
): void {
  logDiagnosticFailure(
    event,
    { failureStage, type },
    error,
    failureStage === "bootstrap" ? "error" : "warn",
  );
}
