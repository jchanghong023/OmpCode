// 会话引擎的 omp 子进程创建与侧信道接线。
// omp 内置斜杠命令侧信道（docs/rpc.md）：本地命令无 agent 生命周期事件，输出与收口
// 全部走 command_output / prompt_result / session_info_update / config_update 这几条边；
// 不接线则 /help、/model 等命令会在 UI 永远转圈。

import type {
  OmpConfigUpdateFrame,
  OmpPromptResultFrame,
  OmpSessionEventFrame,
  OmpSessionInfoUpdateFrame,
  OmpStateData,
  OmpSubagentFrame,
} from "../domain/ompFrames.js";
import type { OmpProcessFactory, OmpSessionProcess } from "./ports.js";
import type { OmpInteractionProxy } from "./ompInteractionProxy.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpBtwFrame } from "../domain/OmpBtwFrames.js";
import type { OmpEventProjector } from "../domain/ompProjector.js";
import { diagnostics } from "./diagnostics.js";
import {
  diagnosticFrameGuard,
  diagnosticSessionStart,
  diagnosticSessionCommand,
  logEngineFailure,
  logModelTransition,
  logStateIgnored,
  observeProjectedEvent,
  readDiagnosticState,
  turnContext,
} from "./turnDiagnostics.js";

/** 单次构造的窄事件桥：热路径不分配 context；引擎仍拥有队列与生命周期。 */
export function createEngineEventHandler(hooks: {
  projection(): ConversationProjection;
  projector(): OmpEventProjector;
  currentProcess(): OmpSessionProcess | null;
  isCurrent(process: OmpSessionProcess): boolean;
  applyState(state: OmpStateData | null): void;
  flush(): void;
  onTerminalEnd(): void;
}): (event: OmpSessionEventFrame) => void {
  return (event) => {
    try {
      // 真实 omp 的 model_changed 不带载荷（#emit({type}) 无字段）：回读 get_state 再落
      // 配置与 modelChange 标记，避免 UI 出现空 provider/model 的占位标记。
      if (event.type === "model_changed" && !event.model) {
        void refreshEngineModelAfterChange(
          hooks.currentProcess(),
          hooks.projection(),
          hooks.applyState,
          hooks.flush,
          hooks.isCurrent,
        );
        return;
      }
      observeProjectedEvent(hooks.projection(), event, hooks.projector());
      if (event.type === "agent_end" && event.isTerminal !== false) {
        // 清流式后补收积压的本地命令完成（收口语义在 promptTurnCloser）。
        // terminal 对账复用 get_state；仍排队且从未 seen 的轮进行 S4-2 宽限复查，
        // 不误关仍在入队路上的排队轮。具体主轮动作仍由引擎回调拥有。
        hooks.onTerminalEnd();
        return;
      }
      hooks.flush();
    } catch (error) {
      logEngineFailure("omp.event.projection.failed", error, "event_projection", event.type);
    }
  };
}

/** 活动后状态回读（agent_end 等）：回读失败不覆盖既有投影，同一进程才应用。 */
export async function refreshEngineStateAfterActivity(
  process: OmpSessionProcess | null,
  isCurrent: (process: OmpSessionProcess) => boolean,
  applyState: (state: OmpStateData | null) => void,
): Promise<void> {
  if (!process) return;
  const fields = { ...diagnostics.context() };
  const state = await readDiagnosticState(process, fields, "omp.state.activity");
  if (isCurrent(process)) applyState(state);
  else logStateIgnored("omp.state.stale_result", fields, Boolean(state));
}

/** 真实 omp 的 model_changed 无载荷：回读 get_state 落配置，模型变化补 modelChange 标记。 */
async function refreshEngineModelAfterChange(
  process: OmpSessionProcess | null,
  projection: ConversationProjection,
  applyState: (state: OmpStateData) => void,
  scheduleFlush: () => void,
  isCurrent: (process: OmpSessionProcess) => boolean,
): Promise<void> {
  if (!process) {
    return;
  }
  const fields = turnContext(projection);
  const state = await readDiagnosticState(process, fields, "omp.model.refresh");
  if (!state || !isCurrent(process)) {
    logStateIgnored("omp.model.refresh.ignored", fields, Boolean(state));
    return;
  }
  const previous = projection.stateSnapshot.config;
  const nextProvider = state.model?.provider ?? previous.provider;
  const nextModel = state.model?.id ?? previous.model;
  applyState(state);
  if (previous.provider !== nextProvider || previous.model !== nextModel) {
    logModelTransition(fields, previous.provider !== nextProvider, previous.model !== nextModel);
    projection.addTimelineMarker({
      type: "modelChange",
      fromProvider: previous.provider,
      fromModel: previous.model,
      toProvider: nextProvider,
      toModel: nextModel,
      toThought: state.thinkingLevel ?? "",
    });
  }
  scheduleFlush();
}

/** startEngineProcess 的宿主表面（ConversationEngine.startOmp 以字面量提供）。 */
export interface EngineProcessStartHost {
  readonly workspacePath: string;
  readonly resumeSessionPath: string | undefined;
  readonly ompFactory: OmpProcessFactory | undefined;
  readonly interaction: OmpInteractionProxy;
  onEvent: (event: OmpSessionEventFrame) => void;
  onExit: (code: number | null, process: OmpSessionProcess) => void;
  onCommandOutput: (frame: { text: string }) => void;
  onPromptResult: (frame: OmpPromptResultFrame) => void;
  onSessionInfoUpdate: (frame: OmpSessionInfoUpdateFrame) => void;
  onConfigUpdate: (frame: OmpConfigUpdateFrame) => void;
  onCommandsUpdate: ((commands: unknown) => void) | undefined;
  onSubagentFrame: (frame: OmpSubagentFrame) => void;
  onBtwFrame?: (frame: OmpBtwFrame) => void;
  currentProcess: () => OmpSessionProcess | null;
  setProcess: (process: OmpSessionProcess | null) => void;
  bootstrap: (process: OmpSessionProcess) => Promise<void>;
}

/**
 * 引擎进程启动（从 conversationEngine.ts 拆出）：按 factory 拉起独立会话进程
 * （--mode rpc-ui [--resume]）；失败回收并允许下次重试。
 */
export async function startEngineProcess(host: EngineProcessStartHost): Promise<void> {
  return diagnosticSessionStart(Boolean(host.resumeSessionPath), async () => {
    if (!host.ompFactory) {
      throw new Error("engine has no omp process source");
    }
    const process = createEngineOmpProcess(
      host.ompFactory,
      { cwd: host.workspacePath, resumeSessionPath: host.resumeSessionPath },
      {
        onEvent: host.onEvent,
        interaction: host.interaction,
        onExit: (code) => {
          // 捕获真正退出的进程，不能把旧回调错误归到当前新进程。
          if (host.currentProcess() === process) host.onExit(code, process);
          else
            diagnostics.debug("omp.session.stale_exit", {
              exitCode: code,
              reason: "process_fence",
            });
        },
        onCommandOutput: host.onCommandOutput,
        onPromptResult: host.onPromptResult,
        onSessionInfoUpdate: host.onSessionInfoUpdate,
        onConfigUpdate: host.onConfigUpdate,
        onCommandsUpdate: (commands) => host.onCommandsUpdate?.(commands),
        onSubagentFrame: host.onSubagentFrame,
        onBtwFrame: host.onBtwFrame,
      },
      // 旧进程退出/关闭后的缓冲帧不得写入重启后的会话或重新打开交互。
      () => host.currentProcess() === process,
    );
    host.setProcess(process);
    diagnostics.info("omp.session.bound", { resumePresent: Boolean(host.resumeSessionPath) });
    try {
      await host.bootstrap(process);
    } catch (error) {
      logEngineFailure("omp.session.bootstrap.failed", error, "bootstrap");
      // 后台读取失败不得留下伪“已启动”进程，下一次用户发送仍可重试。
      if (host.currentProcess() === process) host.setProcess(null);
      await process.dispose();
      throw error;
    }
  });
}

interface EngineProcessHooks {
  onEvent: Parameters<import("./ports.js").OmpProcessFactory["create"]>[0]["onEvent"];
  /** 反向交互请求（extension_ui 含富 ask）统一由交互代理应答。 */
  interaction: OmpInteractionProxy;
  onExit: (code: number | null) => void;
  /** 本地命令输出 → 当前轮助手文本。 */
  onCommandOutput: (frame: { text: string }) => void;
  /** prompt 异步收口（agentInvoked=false：本地命令完成，不会再有 agent 事件）。 */
  onPromptResult: (frame: OmpPromptResultFrame) => void;
  /** /rename 等命令回投会话元信息。 */
  onSessionInfoUpdate: (frame: OmpSessionInfoUpdateFrame) => void;
  /** /model、/thinking 等命令回投会话模型配置。 */
  onConfigUpdate: (frame: OmpConfigUpdateFrame) => void;
  /** 命令目录变化。 */
  onCommandsUpdate: (commands: unknown) => void;
  onSubagentFrame: NonNullable<
    Parameters<import("./ports.js").OmpProcessFactory["create"]>[0]["onSubagentFrame"]
  >;
  onBtwFrame?: (frame: OmpBtwFrame) => void;
}

function createEngineOmpProcess(
  factory: OmpProcessFactory,
  options: { cwd: string; resumeSessionPath?: string },
  hooks: EngineProcessHooks,
  isCurrent: () => boolean = () => true,
): OmpSessionProcess {
  const sessionId = diagnostics.context().sessionId;
  const guard = diagnosticFrameGuard(sessionId, isCurrent);
  return factory.create({
    cwd: options.cwd,
    resumeSessionPath: options.resumeSessionPath,
    onEvent: guard("event", hooks.onEvent),
    onUiRequest: (request) => {
      if (isCurrent()) void hooks.interaction.handle(request);
    },
    onAskRequest: (request) => {
      if (isCurrent()) void hooks.interaction.handleAsk(request);
    },
    onExit: (code) => diagnostics.run({ sessionId }, () => hooks.onExit(code)),
    onCommandOutput: guard("command_output", hooks.onCommandOutput),
    onPromptResult: guard("prompt_result", hooks.onPromptResult),
    onSessionInfoUpdate: guard("session_info_update", hooks.onSessionInfoUpdate),
    onConfigUpdate: guard("config_update", hooks.onConfigUpdate),
    onCommandsUpdate: guard("commands_update", hooks.onCommandsUpdate),
    onSubagentFrame: guard("subagent", hooks.onSubagentFrame),
    onBtwFrame: guard("btw", (frame: OmpBtwFrame) => hooks.onBtwFrame?.(frame)),
  });
}

export interface EngineModelSelection {
  provider: string;
  model: string;
  thought?: string;
}

export { projectEngineContextWindow } from "./ompEngineContextWindow.js";

/**
 * 临时模型（FORK.md）：set_model 只改会话不落盘 omp 配置，与会话工具栏「仅下一次
 * 提交生效」语义一致；与当前配置相同的选择不重复下发（新会话首投也不多花一次往返）。
 * 返回 null 表示已应用（或无需变更），否则为 failTurn 用的错误事实。
 */
export async function applyEngineModelSelection(
  process: OmpSessionProcess,
  selection: EngineModelSelection,
  current: { provider: string; model: string; thought: string },
  isCurrent: () => boolean,
): Promise<{ code: string; message: string } | null> {
  if (!isCurrent()) return { code: "omp_input_cancelled", message: "input dispatch cancelled" };
  if (current.provider !== selection.provider || current.model !== selection.model) {
    const outcome = await diagnosticSessionCommand(process, {
      type: "set_model",
      provider: selection.provider,
      modelId: selection.model,
    });
    if (!outcome.success) {
      return { code: "omp_set_model_failed", message: outcome.error ?? "set_model failed" };
    }
  }
  if (!isCurrent()) return { code: "omp_input_cancelled", message: "input dispatch cancelled" };
  if (selection.thought && selection.thought !== current.thought) {
    // "off" 也是合法档位（rpc.md：set_thinking_level 接受 off），显式关闭思考必须下发。
    const thought = await diagnosticSessionCommand(process, {
      type: "set_thinking_level",
      level: selection.thought,
    });
    if (!thought.success)
      return {
        code: "omp_set_thinking_level_failed",
        message: thought.error ?? "set_thinking_level failed",
      };
  }
  return null;
}

/** UI 提交的 ModelSelection（providerId/modelId/options.reasoningLevel）→ omp set_model 参数；
 *  provider/model 缺失或空串（未选定）不构成有效选择，返回 undefined 由调用方回落会话冻结配置。 */
export function engineModelSelectionOf(
  selection:
    | { providerId?: string; modelId?: string; options?: { reasoningLevel?: string } }
    | undefined
    | null,
): EngineModelSelection | undefined {
  if (
    !selection ||
    typeof selection.providerId !== "string" ||
    typeof selection.modelId !== "string"
  ) {
    return undefined;
  }
  if (selection.providerId.length === 0 || selection.modelId.length === 0) return undefined;
  const reasoning = selection.options?.reasoningLevel;
  const thought = typeof reasoning === "string" && reasoning.length > 0 ? reasoning : undefined;
  return { provider: selection.providerId, model: selection.modelId, thought };
}
