// 会话引擎的 omp 子进程创建与侧信道接线。
// omp 内置斜杠命令侧信道（docs/rpc.md）：本地命令无 agent 生命周期事件，输出与收口
// 全部走 command_output / prompt_result / session_info_update / config_update 这几条边；
// 不接线则 /help、/model 等命令会在 UI 永远转圈。

import type {
  OmpConfigUpdateFrame,
  OmpPromptResultFrame,
  OmpSessionInfoUpdateFrame,
  OmpStateData,
} from "../domain/ompFrames.js";
import type { OmpProcessFactory, OmpSessionProcess } from "./ports.js";
import type { OmpContextReport } from "../domain/ompContextReport.js";
import type { OmpInteractionProxy } from "./ompInteractionProxy.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";

/** 从会话自己的 omp 进程读取当前可执行命令，避免以工作区目录代替会话事实。 */
export async function readOmpSkillCommands(process: OmpSessionProcess): Promise<unknown> {
  const outcome = await process.send({ type: "get_available_commands" });
  if (!outcome.success) throw new Error(outcome.error ?? "omp command catalog unavailable");
  const record =
    typeof outcome.data === "object" && outcome.data !== null
      ? (outcome.data as { commands?: unknown })
      : {};
  return record.commands;
}

/** 活动后状态回读（agent_end 等）：回读失败不覆盖既有投影，同一进程才应用。 */
export async function refreshEngineStateAfterActivity(
  process: OmpSessionProcess | null,
  isCurrent: (process: OmpSessionProcess) => boolean,
  applyState: (state: OmpStateData | null) => void,
): Promise<void> {
  if (!process) return;
  const state = await process.refreshState().catch(() => null);
  if (isCurrent(process)) applyState(state);
}

/** 真实 omp 的 model_changed 无载荷：回读 get_state 落配置，模型变化补 modelChange 标记。 */
export async function refreshEngineModelAfterChange(
  process: OmpSessionProcess | null,
  projection: ConversationProjection,
  applyState: (state: OmpStateData) => void,
  scheduleFlush: () => void,
): Promise<void> {
  if (!process) {
    return;
  }
  const state = await process.refreshState().catch(() => null);
  if (!state) {
    return;
  }
  const previous = projection.stateSnapshot.config;
  const nextProvider = state.model?.provider ?? previous.provider;
  const nextModel = state.model?.id ?? previous.model;
  applyState(state);
  if (previous.provider !== nextProvider || previous.model !== nextModel) {
    projection.addTimelineMarker({ type: "modelChange", fromProvider: previous.provider, fromModel: previous.model, toProvider: nextProvider, toModel: nextModel, toThought: state.thinkingLevel ?? "" });
  }
  scheduleFlush();
}

export interface EngineProcessHooks {
  onEvent: Parameters<import("./ports.js").OmpProcessFactory["create"]>[0]["onEvent"];
  /** 三类反向交互请求（extension_ui / permission / ask）统一由交互代理应答。 */
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
}

export function createEngineOmpProcess(
  factory: OmpProcessFactory,
  options: { cwd: string; resumeSessionPath?: string },
  hooks: EngineProcessHooks,
): OmpSessionProcess {
  return factory.create({
    cwd: options.cwd,
    resumeSessionPath: options.resumeSessionPath,
    onEvent: hooks.onEvent,
    onUiRequest: (request) => void hooks.interaction.handle(request),
    onPermissionRequest: (request) => void hooks.interaction.handlePermission(request),
    onAskRequest: (request) => void hooks.interaction.handleAsk(request),
    onExit: hooks.onExit,
    onCommandOutput: hooks.onCommandOutput,
    onPromptResult: hooks.onPromptResult,
    onSessionInfoUpdate: hooks.onSessionInfoUpdate,
    onConfigUpdate: hooks.onConfigUpdate,
    onCommandsUpdate: hooks.onCommandsUpdate,
    onSubagentFrame: hooks.onSubagentFrame,
  });
}

export interface EngineModelSelection {
  provider: string;
  model: string;
  thought?: string;
}

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

export async function applyEngineThoughtLevel(
  level: string,
  ensureStarted: () => Promise<void>,
  currentProcess: () => OmpSessionProcess | null,
): Promise<{ error?: string }> {
  try {
    await ensureStarted();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const outcome = await currentProcess()?.send({ type: "set_thinking_level", level });
  return outcome?.success ? {} : { error: outcome?.error ?? "set_thinking_level failed" };
}

/** 手动压缩以 omp 命令结果为准；状态回读失败不改变已经完成的压缩结果。 */
export async function applyEngineCompaction(
  ensureStarted: () => Promise<void>,
  currentProcess: () => OmpSessionProcess | null,
  refreshState: () => Promise<void>,
): Promise<boolean> {
  try {
    await ensureStarted();
    const outcome = await currentProcess()?.send({ type: "compact" });
    if (outcome?.success !== true) return false;
    try {
      await refreshState();
    } catch {
      // 压缩已经成功；回读失败只影响最新上下文显示。
    }
    return true;
  } catch {
    return false;
  }
}

export async function applyEngineSetModel(
  selection: EngineModelSelection,
  ensureStarted: () => Promise<void>,
  currentProcess: () => OmpSessionProcess | null,
): Promise<{ error?: string }> {
  try {
    await ensureStarted();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const process = currentProcess();
  if (!process) return { error: "omp core failed to start" };
  const outcome = await process.send({
    type: "set_model",
    provider: selection.provider,
    modelId: selection.model,
  });
  if (!outcome.success) return { error: outcome.error ?? "set_model failed" };
  if (selection.thought) {
    // "off" 是合法档位（rpc.md：set_thinking_level 接受 off），显式关闭思考必须下发。
    await process.send({ type: "set_thinking_level", level: selection.thought });
  }
  return {};
}

/**
 * 临时模型（FORK.md）：set_model 只改会话不落盘 omp 配置，与会话工具栏「仅下一次
 * 提交生效」语义一致；与当前配置相同的选择不重复下发（新会话首投也不多花一次往返）。
 * 返回 null 表示已应用（或无需变更），否则为 failTurn 用的错误事实。
 */
export async function applyEngineModelSelection(
  process: OmpSessionProcess,
  selection: EngineModelSelection,
  current: { provider: string; model: string; thought: string },
): Promise<{ code: string; message: string } | null> {
  if (current.provider !== selection.provider || current.model !== selection.model) {
    const outcome = await process.send({
      type: "set_model",
      provider: selection.provider,
      modelId: selection.model,
    });
    if (!outcome.success) {
      return { code: "omp_set_model_failed", message: outcome.error ?? "set_model failed" };
    }
  }
  if (selection.thought && selection.thought !== current.thought) {
    // "off" 也是合法档位（rpc.md：set_thinking_level 接受 off），显式关闭思考必须下发。
    await process.send({ type: "set_thinking_level", level: selection.thought });
  }
  return null;
}

/** 自动压缩由 omp 持有；切换后回读状态，不能把请求值当作最终事实。 */
export async function applyEngineAutoCompaction(
  enabled: boolean,
  ensureStarted: () => Promise<void>,
  currentProcess: () => OmpSessionProcess | null,
  applyState: (state: OmpStateData) => void,
): Promise<{ error?: string }> {
  try {
    await ensureStarted();
    const process = currentProcess();
    const outcome = await process?.send({ type: "set_auto_compaction", enabled });
    if (!outcome?.success) return { error: outcome?.error ?? "set_auto_compaction failed" };
    const state = await process?.refreshState();
    if (!state || state.autoCompactionEnabled === undefined) {
      return { error: "omp did not return auto-compaction state" };
    }
    applyState(state);
    return state.autoCompactionEnabled === enabled
      ? {}
      : { error: "omp auto-compaction state differs from requested value" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
