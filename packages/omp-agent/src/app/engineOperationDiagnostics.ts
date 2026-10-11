import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpStateData } from "../domain/ompFrames.js";
import type { EngineModelSelection } from "./ompEngineProcess.js";
import type { OmpSessionProcess } from "./ports.js";
import { diagnostics } from "./diagnostics.js";
import {
  diagnosticOperation,
  diagnosticSessionCommand,
  logEngineFailure,
  turnContext,
} from "./turnDiagnostics.js";

/** 只借引擎的操作入口，不缓存进程、配置或队列事实。 */
export interface EngineOperationHost {
  sessionId(): string;
  ensureStarted(): Promise<void>;
  currentProcess(): OmpSessionProcess | null;
  refreshState(): Promise<void>;
  applyState(state: OmpStateData): void;
}

export function runEngineOperation<T>(
  host: Pick<EngineOperationHost, "sessionId">,
  event: string,
  callback: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  return diagnostics.run({ sessionId: host.sessionId() }, () =>
    diagnosticOperation(event, fields, callback),
  );
}

/** 从会话自己的 omp 进程读取当前可执行命令，避免以工作区目录代替会话事实。 */
export function readEngineSkillCommands(host: EngineOperationHost): Promise<unknown> {
  return runEngineOperation(host, "omp.session.commands", async () => {
    await host.ensureStarted();
    return readOmpSkillCommands(host.currentProcess()!);
  });
}

async function readOmpSkillCommands(process: OmpSessionProcess): Promise<unknown> {
  const outcome = await diagnosticSessionCommand(process, { type: "get_available_commands" });
  if (!outcome.success) throw new Error(outcome.error ?? "omp command catalog unavailable");
  const record =
    typeof outcome.data === "object" && outcome.data !== null
      ? (outcome.data as { commands?: unknown })
      : {};
  return record.commands;
}

export async function stopEngineOperation(
  host: EngineOperationHost,
  projection: ConversationProjection,
  prepareAbortReconciliation: () => () => Promise<void>,
  scheduleFlush: () => void,
): Promise<void> {
  try {
    await host.ensureStarted();
    const reconcileAbort = prepareAbortReconciliation();
    const process = host.currentProcess();
    const outcome = process
      ? await diagnostics.run({ sessionId: host.sessionId() }, () =>
          diagnosticSessionCommand(process, { type: "abort" }),
        )
      : undefined;
    if (!outcome?.success)
      diagnostics.warn("omp.session.stop.failed", {
        ...turnContext(projection),
        failureStage: process ? "core_rejection" : "process_unavailable",
      });
    if (outcome?.success) await reconcileAbort();
  } catch (error) {
    diagnostics.warn("omp.session.stop.failed", {
      ...turnContext(projection),
      failureStage: "stop_exception",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    scheduleFlush();
  }
}

export function applyEngineThoughtLevel(
  host: EngineOperationHost,
  level: string,
): Promise<{ error?: string }> {
  return runEngineOperation(host, "omp.session.thought", async () => {
    try {
      await host.ensureStarted();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const process = host.currentProcess();
    const outcome = process
      ? await diagnosticSessionCommand(process, { type: "set_thinking_level", level })
      : undefined;
    return outcome?.success ? {} : { error: outcome?.error ?? "set_thinking_level failed" };
  });
}

/** 手动压缩以 omp 命令结果为准；状态回读失败不改变已经完成的压缩结果。 */
export function applyEngineCompaction(host: EngineOperationHost): Promise<boolean> {
  return runEngineOperation(host, "omp.session.compact", async () => {
    try {
      await host.ensureStarted();
      const process = host.currentProcess();
      const outcome = process
        ? await diagnosticSessionCommand(process, { type: "compact" })
        : undefined;
      if (outcome?.success !== true) return false;
      try {
        await host.refreshState();
      } catch {
        // 压缩已经成功；回读失败只影响最新上下文显示。
        logEngineFailure("omp.compact.state_refresh.failed", undefined, "state_read_after_success");
      }
      return true;
    } catch {
      return false;
    }
  });
}

export function applyEngineSetModel(
  host: EngineOperationHost,
  selection: EngineModelSelection,
): Promise<{ error?: string }> {
  return runEngineOperation(
    host,
    "omp.session.model",
    async () => {
      try {
        await host.ensureStarted();
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const process = host.currentProcess();
      if (!process) return { error: "omp core failed to start" };
      const outcome = await diagnosticSessionCommand(process, {
        type: "set_model",
        provider: selection.provider,
        modelId: selection.model,
      });
      if (!outcome.success) return { error: outcome.error ?? "set_model failed" };
      if (selection.thought) {
        // "off" 是合法档位（rpc.md：set_thinking_level 接受 off），显式关闭思考必须下发。
        const thought = await diagnosticSessionCommand(process, {
          type: "set_thinking_level",
          level: selection.thought,
        });
        if (!thought.success) return { error: thought.error ?? "set_thinking_level failed" };
      }
      return {};
    },
    { thoughtPresent: Boolean(selection.thought) },
  );
}

/** 自动压缩由 omp 持有；切换后回读状态，不能把请求值当作最终事实。 */
export function applyEngineAutoCompaction(
  host: EngineOperationHost,
  enabled: boolean,
): Promise<{ error?: string }> {
  return runEngineOperation(
    host,
    "omp.session.auto_compaction",
    async () => {
      try {
        await host.ensureStarted();
        const process = host.currentProcess();
        const outcome = process
          ? await diagnosticSessionCommand(process, { type: "set_auto_compaction", enabled })
          : undefined;
        if (!outcome?.success) return { error: outcome?.error ?? "set_auto_compaction failed" };
        const state = await process?.refreshState();
        if (!state || state.autoCompactionEnabled === undefined) {
          return { error: "omp did not return auto-compaction state" };
        }
        host.applyState(state);
        return state.autoCompactionEnabled === enabled
          ? {}
          : { error: "omp auto-compaction state differs from requested value" };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    { enabled },
  );
}
