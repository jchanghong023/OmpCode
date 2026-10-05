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
import type { OmpProcessFactory, OmpSessionProcess, OmpSessionProcessHandlers } from "./ports.js";
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
  readonly acquireProjectProcess:
    | ((handlers: OmpSessionProcessHandlers) => Promise<OmpSessionProcess>)
    | undefined;
  readonly interaction: OmpInteractionProxy;
  onEvent: (event: OmpSessionEventFrame) => void;
  onExit: (code: number | null, process: OmpSessionProcess) => void;
  onCommandOutput: (frame: { text: string }) => void;
  onPromptResult: (frame: OmpPromptResultFrame) => void;
  onSessionInfoUpdate: (frame: OmpSessionInfoUpdateFrame) => void;
  onConfigUpdate: (frame: OmpConfigUpdateFrame) => void;
  onCommandsUpdate: ((commands: unknown) => void) | undefined;
  onSubagentFrame: (frame: OmpSubagentFrame) => void;
  currentProcess: () => OmpSessionProcess | null;
  setProcess: (process: OmpSessionProcess | null) => void;
  bootstrap: (process: OmpSessionProcess) => Promise<void>;
}

/** 项目通道的存活事实（OmpProjectSessionChannel.alive；端口未声明，按结构读取：
 * false = 通道已随共享项目进程死亡/卸载，undefined = 不携带该事实视为存活）。 */
interface OmpChannelLiveness {
  readonly alive?: boolean;
}

/**
 * 引擎进程启动（从 conversationEngine.ts 拆出）：项目模式取共享进程通道（失败不清空，
 * 可重试），旧拓扑按 factory 拉起独立进程（失败回收并允许下次重试）。
 */
export async function startEngineProcess(host: EngineProcessStartHost): Promise<void> {
  const handlers: OmpSessionProcessHandlers = {
    onEvent: host.onEvent,
    onUiRequest: (request) => void host.interaction.handle(request),
    onPermissionRequest: (request) => void host.interaction.handlePermission(request),
    onAskRequest: (request) => void host.interaction.handleAsk(request),
    onExit: (code) => {
      const current = host.currentProcess();
      if (current) host.onExit(code, current);
    },
    onCommandOutput: host.onCommandOutput,
    onPromptResult: host.onPromptResult,
    onSessionInfoUpdate: host.onSessionInfoUpdate,
    onConfigUpdate: host.onConfigUpdate,
    onCommandsUpdate: (commands) => host.onCommandsUpdate?.(commands),
    onSubagentFrame: host.onSubagentFrame,
  };
  if (host.acquireProjectProcess) {
    // 修复（S7-1）：共享项目进程可能在「通道获取 → setProcess」窗口内死亡，此时引擎
    // 尚未 setProcess，exit 事件被上方 current 守卫吞掉；bootstrap 随后在死通道上
    // “成功”完成（start/refreshState 均吞错），引擎从此永久绑定死通道——之后一切请求
    // 返回 "omp project core is not running"，直到适配器重启。依据 rpc-ui-protocol
    // §13.3（进程意外退出属可重试失败，重启后幂等重建），bootstrap 完成后校验通道
    // alive 事实：死通道按旧拓扑失败同语义清理（setProcess(null) + dispose 通道）并
    // 按可重试失败抛出，下次调用经 gateway.acquireSessionChannel 幂等重建。
    let process: OmpSessionProcess | null = null;
    try {
      process = await host.acquireProjectProcess(handlers);
      host.setProcess(process);
      // 失败不清空：通道与会话仍在（OMP 侧已加载），下一次调用可重试。
      await host.bootstrap(process);
    } catch (error) {
      // bootstrap 抛错且通道已死（进程死亡是常见根因）：同语义清理后按可重试失败抛出；
      // 活通道保持「不清空、可重试」的既有语义。
      if (process && (process as OmpChannelLiveness).alive === false) {
        if (host.currentProcess() === process) host.setProcess(null);
        await process.dispose().catch(() => {});
      }
      throw error;
    }
    if ((process as OmpChannelLiveness).alive === false) {
      if (host.currentProcess() === process) host.setProcess(null);
      await process.dispose().catch(() => {});
      throw new Error("omp project core exited while bootstrapping session channel");
    }
    return;
  }
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
        const current = host.currentProcess();
        if (current) host.onExit(code, current);
      },
      onCommandOutput: (frame) => handlers.onCommandOutput?.(frame),
      onPromptResult: (frame) => handlers.onPromptResult?.(frame),
      onSessionInfoUpdate: (frame) => handlers.onSessionInfoUpdate?.(frame),
      onConfigUpdate: (frame) => handlers.onConfigUpdate?.(frame),
      onCommandsUpdate: (commands) => handlers.onCommandsUpdate?.(commands),
      onSubagentFrame: (frame) => handlers.onSubagentFrame?.(frame),
    },
  );
  host.setProcess(process);
  try {
    await host.bootstrap(process);
  } catch (error) {
    // 后台读取失败不得留下伪“已启动”进程，下一次用户发送仍可重试。
    if (host.currentProcess() === process) host.setProcess(null);
    await process.dispose();
    throw error;
  }
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

export { readEngineContextDetails, projectEngineContextWindow } from "./ompEngineContextWindow.js";

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
