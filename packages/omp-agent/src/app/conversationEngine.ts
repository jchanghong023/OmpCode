// ConversationEngine：一个 ZCode 会话 = 一个投影 + 一个（惰性启动的）omp 子进程。
// 职责：omp 事件 → 投影 → 订阅者帧；v4 命令到 omp 命令的翻译入口；交互请求代理。
import type { ConversationRow, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../domain/conversationProjection.js";
import { OmpEventProjector } from "../domain/ompProjector.js";
import { createId } from "../domain/ids.js";
import type { OmpSessionEventFrame, OmpStateData } from "../domain/ompFrames.js";
import type { HostGateway, HostUserInputAnswer, OmpProcessFactory, OmpSessionProcess } from "./ports.js";
import { ConversationTopicPublisher, type SubscribeOptions } from "./topicPublisher.js";
import { OmpInteractionProxy } from "./ompInteractionProxy.js";
import { applyEngineAutoCompaction, applyEngineCompaction, applyEngineSetModel, applyEngineThoughtLevel, createEngineOmpProcess, readEngineContextDetails } from "./ompEngineProcess.js";
import { dispatchOmpText } from "./ompPromptDispatch.js";
import { TrailingThrottle } from "./trailingThrottle.js";
import { deriveTitle, agentInvokedOf } from "../domain/titleText.js";
import { OmpSubagentBridge } from "./ompSubagentBridge.js";

export interface EngineInit {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  ompFactory: OmpProcessFactory;
  gateway: HostGateway;
  onIndexChange: (engine: ConversationEngine) => void;
  /** omp 命令目录热更新出口（available_commands_update 原始命令数组）。 */
  onCommandsUpdate?: (commands: unknown) => void;
  resumeSessionPath?: string;
  initialTitle?: string;
}

export class ConversationEngine {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly projection: ConversationProjection;
  private readonly projector: OmpEventProjector;
  private readonly ompFactory: OmpProcessFactory;
  private readonly gateway: HostGateway;
  private readonly onIndexChange: (engine: ConversationEngine) => void;
  private readonly onCommandsUpdate: ((commands: unknown) => void) | undefined;
  private readonly publisher: ConversationTopicPublisher;
  private readonly interactionProxy: OmpInteractionProxy;
  private ompProcess: OmpSessionProcess | null = null;
  private ompStarting: Promise<void> | null = null;
  private readonly indexNotify = new TrailingThrottle(500, () => this.notifyIndexChange());
  private resumeSessionPath: string | undefined;
  private followupMode: SessionConfigState["followupMode"] = "queue";
  private pendingLocalOnlyCompletions = 0;
  private titleInitialized: boolean;
  private readonly subagents: OmpSubagentBridge;
  constructor(init: EngineInit) {
    this.sessionId = init.sessionId;
    this.workspaceId = init.workspaceId;
    this.workspacePath = init.workspacePath;
    this.ompFactory = init.ompFactory;
    this.gateway = init.gateway;
    this.onIndexChange = init.onIndexChange;
    this.onCommandsUpdate = init.onCommandsUpdate;
    this.resumeSessionPath = init.resumeSessionPath;
    this.projection = new ConversationProjection(init.sessionId);
    this.subagents = new OmpSubagentBridge(this.projection, () => this.ompProcess, () => this.scheduleFlush());
    this.projector = new OmpEventProjector(this.projection);
    this.interactionProxy = new OmpInteractionProxy({
      sessionId: init.sessionId,
      gateway: init.gateway,
      addPendingInteraction: (interaction) => this.projection.addPendingInteraction(interaction),
      resolvePendingInteraction: (interactionId) => this.projection.resolvePendingInteraction(interactionId),
      scheduleFlush: () => this.scheduleFlush(),
    });
    this.publisher = new ConversationTopicPublisher(init.sessionId, this.projection, init.gateway);
    this.titleInitialized = Boolean(init.initialTitle);
    if (init.initialTitle) {
      this.projection.setTitle(init.initialTitle, "default");
    }
  }
  get ompSessionFile(): string | null {
    return this.ompProcess?.ompSessionFile ?? this.resumeSessionPath ?? null;
  }
  async ensureOmpStarted(): Promise<void> {
    // 订阅冷会话会后台启动 omp；此时进程对象已创建但 ready/get_state 还未完成。
    // 后续发送必须等待同一启动 promise，不能把对象存在误当成进程就绪。
    if (this.ompStarting) {
      await this.ompStarting;
      return;
    }
    if (this.ompProcess) {
      return;
    }
    this.ompStarting = this.startOmp().finally(() => {
      this.ompStarting = null;
    });
    await this.ompStarting;
  }
  private async startOmp(): Promise<void> {
    let process!: OmpSessionProcess;
    process = createEngineOmpProcess(
      this.ompFactory,
      { cwd: this.workspacePath, resumeSessionPath: this.resumeSessionPath },
      {
        onEvent: (event) => this.handleOmpEvent(event),
        onUiRequest: (request) => void this.interactionProxy.handle(request),
        onExit: (code) => this.handleOmpExit(code, process),
        onCommandOutput: ({ text }) => {
          if (!this.projector.isStreaming) this.projection.activateQueuedTurn();
          this.projection.appendAssistantText(text);
          this.scheduleFlush();
        },
        // agentInvoked=true 的完成帧紧随 agent_end，不能覆盖失败或中断终态。
        onPromptResult: (frame) => { if (frame.agentInvoked === false) this.finishLocalOnlyPrompt(); },
        onSessionInfoUpdate: ({ title }) => this.applySessionTitle(title),
        onConfigUpdate: ({ model, thinkingLevel }) => {
          this.projection.setModelConfig({
            ...(model?.provider !== undefined ? { provider: model.provider } : {}),
            ...(model?.id !== undefined ? { model: model.id } : {}),
            ...(thinkingLevel !== undefined ? { thought: thinkingLevel } : {}),
          });
          this.notifyIndexChange();
          this.scheduleFlush();
        },
        onCommandsUpdate: (commands) => this.onCommandsUpdate?.(commands),
        onSubagentFrame: (frame) => this.subagents.handle(frame),
      },
    );
    this.ompProcess = process;
    try {
      await process.start();
      this.projection.setSubagentAvailability(process.subagentSubscriptionAvailable === false ? "unavailable" : "ready");
      this.scheduleFlush();
      const state = await process.refreshState();
      this.applyOmpState(state);
      await this.subagents.refresh(process);
    } catch (error) {
      // 后台读取失败不得留下伪“已启动”进程，下一次用户发送仍可重试。
      if (this.ompProcess === process) this.ompProcess = null;
      await process.dispose();
      throw error;
    }
  }
  private applySessionTitle(title: string | undefined): void {
    if (title && title.trim().length > 0) {
      this.titleInitialized = true;
      this.projection.setTitle(title, "custom");
      this.notifyIndexChange();
      this.scheduleFlush();
    }
  }
  /** 本地命令收口（prompt 响应 data.agentInvoked=false 或异步 prompt_result）。 */
  private finishLocalOnlyPrompt(): void {
    if (this.projector.isStreaming) {
      this.pendingLocalOnlyCompletions += 1;
      return;
    }
    if (!this.projection.finishQueuedLocalOnlyTurn()) {
      this.projection.closeAssistantResponse();
      this.projection.finishTurn("success");
    }
    this.scheduleFlush();
  }
  private applyOmpState(state: OmpStateData | null): void {
    if (!state) {
      return;
    }
    this.projection.setModelConfig({
      ...(state.model?.provider !== undefined ? { provider: state.model.provider } : {}),
      ...(state.model?.id !== undefined ? { model: state.model.id } : {}),
      ...(state.thinkingLevel !== undefined ? { thought: state.thinkingLevel } : {}),
      ...(state.autoCompactionEnabled !== undefined ? { autoCompactionEnabled: state.autoCompactionEnabled } : {}),
    });
    if (state.contextUsage && typeof state.contextUsage.contextWindow === "number") {
      const used = state.contextUsage.tokens ?? 0;
      const size = state.contextUsage.contextWindow;
      this.projection.setContextWindow(used, size);
      const process = this.ompProcess;
      if (process && this.projection.stateSnapshot.control.phase !== "running") {
        readEngineContextDetails(process,
          () => this.ompProcess === process && this.projection.stateSnapshot.control.phase !== "running"
            && this.projection.stateSnapshot.usage.contextWindow?.usedTokens === used
            && this.projection.stateSnapshot.usage.contextWindow?.maxTokens === size,
          (report) => { this.projection.setContextWindow(used, size, report); this.scheduleFlush(); });
      }
    }
    if (!this.titleInitialized && state.sessionName) {
      this.titleInitialized = true;
      this.projection.setTitle(state.sessionName, "generated");
    }
    this.notifyIndexChange();
    this.scheduleFlush();
  }
  private handleOmpEvent(event: OmpSessionEventFrame): void {
    // 真实 omp 的 model_changed 不带载荷（#emit({type}) 无字段）：回读 get_state 再落
    // 配置与 modelChange 标记，避免 UI 出现空 provider/model 的占位标记。
    if (event.type === "model_changed" && !event.model) {
      void this.refreshModelAfterChange();
      return;
    }
    this.projector.handleEvent(event);
    if (event.type === "agent_end" && event.isTerminal !== false) {
      while (this.pendingLocalOnlyCompletions > 0) {
        this.pendingLocalOnlyCompletions -= 1;
        this.finishLocalOnlyPrompt();
      }
    }
    this.scheduleFlush();
    if (event.type === "agent_end" && event.isTerminal !== false) {
      void this.refreshStateAfterActivity();
    }
  }
  private async refreshStateAfterActivity(): Promise<void> {
    const process = this.ompProcess;
    if (!process) return;
    const state = await process.refreshState().catch(() => null);
    if (this.ompProcess === process) this.applyOmpState(state);
  }
  private async refreshModelAfterChange(): Promise<void> {
    const process = this.ompProcess;
    if (!process) {
      return;
    }
    const state = await process.refreshState().catch(() => null);
    if (!state) {
      return;
    }
    const previous = this.projection.stateSnapshot.config;
    const nextProvider = state.model?.provider ?? previous.provider;
    const nextModel = state.model?.id ?? previous.model;
    this.applyOmpState(state);
    if (previous.provider !== nextProvider || previous.model !== nextModel) {
      this.projection.addTimelineMarker({
        type: "modelChange",
        fromProvider: previous.provider,
        fromModel: previous.model,
        toProvider: nextProvider,
        toModel: nextModel,
        toThought: state.thinkingLevel ?? "",
      });
    }
    this.scheduleFlush();
  }
  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settleInteraction(interactionId: string, answer: HostUserInputAnswer): boolean {
    return this.interactionProxy.settle(interactionId, answer);
  }
  private handleOmpExit(code: number | null, process: OmpSessionProcess): void {
    if (this.ompProcess !== process) return;
    // 崩溃时先保存 omp 进程的会话文件，供下次 --resume 使用。
    const exitedSessionFile = process.ompSessionFile;
    if (exitedSessionFile) this.resumeSessionPath = exitedSessionFile;
    this.ompProcess = null;
    this.pendingLocalOnlyCompletions = 0;
    this.interactionProxy.dispose();
    const error = { code: "omp_process_exit", message: `omp core exited unexpectedly (code ${code ?? "null"})` };
    this.projection.failAllTurns(error);
    // 崩溃无 agent_end；必须在 exit 时清流式状态，避免重启前的输入误走 follow_up。
    this.projector.resetForRestart();
    this.scheduleFlush();
  }
  // ── 命令翻译 ──
  /** 发送用户输入；返回实际 delivery（omp 流式中转为 follow_up 队列）。图片附件直接进 omp prompt。 */
  async sendText(
    text: string,
    sourceCommandId: string,
    clientId: string,
    images: { type: "image"; data: string; mimeType: string }[] = [],
    modelSelection?: { provider: string; model: string; thought?: string },
  ): Promise<"startNow" | "queue"> {
    if (!this.titleInitialized && text.trim().length > 0) {
      this.titleInitialized = true;
      this.projection.setTitle(deriveTitle(text), "generated");
    }
    const inputId = createId("input");
    const streaming = this.projector.isStreaming;
    this.projection.beginUserTurn({ text, inputId, sourceCommandId, clientId,
      routing: streaming ? this.followupMode : "startNow" });
    this.scheduleFlush();
    try {
      await this.ensureOmpStarted();
    } catch (error) {
      this.failTurn(sourceCommandId, "omp_start_failed", error);
      return streaming ? "queue" : "startNow";
    }
    const process = this.ompProcess;
    if (!process) {
      this.failTurn(sourceCommandId, "omp_unavailable", new Error("omp core failed to start"));
      return streaming ? "queue" : "startNow";
    }
    try {
      const outcome = await dispatchOmpText({
        process, text, images, streaming, followupMode: this.followupMode,
        modelSelection, currentConfig: this.projection.stateSnapshot.config,
      });
      if (!outcome.success) {
        this.failTurn(sourceCommandId, outcome.code ?? "omp_prompt_failed", new Error(outcome.error ?? "prompt rejected"));
        return streaming ? "queue" : "startNow";
      }
      if (agentInvokedOf(outcome.data) === false) {
        this.finishLocalOnlyPrompt();
      }
    } catch (error) {
      // omp RPC 超时或进程退出会 reject，必须结束对应轮次。
      this.failTurn(sourceCommandId, "omp_prompt_failed", error);
    }
    return streaming ? "queue" : "startNow";
  }
  private failTurn(sourceCommandId: string, code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.projection.failCommandTurn(sourceCommandId, { code, message });
    this.scheduleFlush();
  }
  async stop(): Promise<void> {
    this.projector.noteStopRequested();
    this.scheduleFlush();
    try {
      await this.ensureOmpStarted();
      await this.ompProcess?.send({ type: "abort" });
    } catch {
      this.scheduleFlush();
    }
  }
  async compact(): Promise<void> {
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: "running" });
    this.scheduleFlush();
    const success = await applyEngineCompaction(
      () => this.ensureOmpStarted(), () => this.ompProcess, () => this.refreshStateAfterActivity());
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: success ? "success" : "failed" });
    this.scheduleFlush();
  }
  async setAutoCompaction(enabled: boolean): Promise<{ error?: string }> {
    return applyEngineAutoCompaction(enabled, () => this.ensureOmpStarted(), () => this.ompProcess,
      (state) => this.applyOmpState(state));
  }
  async setModel(provider: string, model: string, thought?: string): Promise<{ error?: string }> {
    return applyEngineSetModel({ provider, model, thought },
      () => this.ensureOmpStarted(), () => this.ompProcess);
  }

  /**
   * ZCode followup 模式收敛：guide/queue 均接受并如实投影。实际路由在 sendText 流式分支
   * （guide→steer、queue→follow_up），omp 队列默认 one-at-a-time 已满足「每轮一条」，无需下发命令。
   */
  setFollowupMode(mode: SessionConfigState["followupMode"]): void {
    this.followupMode = mode;
    this.projection.setModelConfig({ followupMode: mode });
    this.scheduleFlush();
  }

  async setThoughtLevel(level: string): Promise<{ error?: string }> {
    return applyEngineThoughtLevel(level, () => this.ensureOmpStarted(), () => this.ompProcess);
  }

  async rename(title: string): Promise<void> {
    this.projection.setTitle(title, "custom");
    this.notifyIndexChange();
    this.scheduleFlush();
    if (this.ompProcess) {
      await this.ompProcess.send({ type: "set_session_name", name: title });
    }
  }

  async dispose(): Promise<void> {
    this.indexNotify.dispose();
    this.publisher.dispose();
    this.interactionProxy.dispose();
    const process = this.ompProcess;
    this.ompProcess = null;
    await process?.dispose();
  }

  // ── 订阅与帧（实现在 topicPublisher）──
  subscribe(params: SubscribeOptions): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    const ack = this.publisher.subscribe(params);
    // 冷历史先到 UI；已保存会话再后台恢复 omp，get_state 会把真实上下文和自动压缩状态投影给同一订阅。
    if (this.resumeSessionPath) void this.ensureOmpStarted().catch(() => {});
    return ack;
  }

  unsubscribe(subscriptionId: string): void {
    this.publisher.unsubscribe(subscriptionId);
  }

  resync(
    subscriptionId: string,
    base: { logEpoch: string; seq: number } | null,
    forceSnapshot = false,
  ): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    return this.publisher.resync(subscriptionId, base, forceSnapshot);
  }

  private scheduleFlush(): void {
    this.publisher.scheduleFlush(() => this.indexNotify.ping());
  }

  private notifyIndexChange(): void {
    this.onIndexChange(this);
  }

  /** 冷恢复：把历史行放入投影（订阅建立前调用）。 */
  hydrateRows(rows: ConversationRow[]): void {
    this.projection.hydrateRows(rows);
  }
}
