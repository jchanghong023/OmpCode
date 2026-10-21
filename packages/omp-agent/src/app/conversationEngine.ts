// ConversationEngine：一个 ZCode 会话 = 一个投影 + 一个（惰性启动的）omp 子进程。
// 职责：omp 事件 → 投影 → 订阅者帧；v4 命令到 omp 命令的翻译入口；交互请求代理。
import type { ConversationRow, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../domain/conversationProjection.js";
import { OmpEventProjector } from "../domain/ompProjector.js";
import type { OmpSessionEventFrame, OmpStateData } from "../domain/ompFrames.js";
import type { HostGateway, HostUserInputAnswer, OmpProcessFactory, OmpSessionProcess } from "./ports.js";
import { ConversationTopicPublisher, type SubscribeOptions } from "./topicPublisher.js";
import { OmpInteractionProxy } from "./ompInteractionProxy.js";
import { projectEngineContextWindow, startEngineProcess, createEngineEventHandler, refreshEngineStateAfterActivity } from "./ompEngineProcess.js";
import { applyEngineAutoCompaction, applyEngineCompaction, applyEngineSetModel, applyEngineThoughtLevel, readEngineSkillCommands, runEngineOperation, stopEngineOperation, type EngineOperationHost } from "./engineOperationDiagnostics.js";
import type { SlashCommandResolver } from "./ompPromptDispatch.js";
import { EnginePromptTurnCloser, type QueueItemActionResult } from "./promptTurnCloser.js";
import { TrailingThrottle } from "./trailingThrottle.js";
import { deriveTitle } from "../domain/titleText.js";
import { OmpSubagentBridge } from "./ompSubagentBridge.js";
import type { EngineInit } from "./engineInit.js";
import { OmpBtwEventBridge } from "./OmpBtwEventBridge.js";
import { OmpCommandOutputBridge } from "./ompCommandOutput.js";
import { OmpAgentInteractionLog } from "../domain/OmpAgentInteractionLog.js";
import { diagnostics } from "./diagnostics.js";
import { diagnosticSessionCommand, logSessionExit, logTurnTransitions } from "./turnDiagnostics.js";
import { EngineSessionClock } from "./engineSessionClock.js";
export class ConversationEngine {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly projection: ConversationProjection;
  readonly projector: OmpEventProjector;
  readonly agentInteractions = new OmpAgentInteractionLog();
  private readonly historyClock = new EngineSessionClock();
  get createdAt(): number {
    return this.historyClock.createdAt;
  }
  get activityBaselineAt(): number {
    return this.historyClock.activityBaselineAt;
  }
  private readonly ompFactory: OmpProcessFactory | undefined;
  private readonly gateway: HostGateway;
  private readonly onIndexChange: (engine: ConversationEngine) => void;
  private readonly onCommandsUpdate: ((commands: unknown) => void) | undefined;
  private readonly commandOutputs: OmpCommandOutputBridge;
  private readonly resolveSlashCommand: SlashCommandResolver | undefined;
  private readonly forwardSubagentFrame: ((frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void) | undefined;
  private readonly publisher: ConversationTopicPublisher;
  private readonly interactionProxy: OmpInteractionProxy;
  private ompProcess: OmpSessionProcess | null = null;
  private ompStarting: Promise<void> | null = null;
  private readonly operationHost: EngineOperationHost = { sessionId: () => this.sessionId, ensureStarted: () => this.ensureOmpStarted(), currentProcess: () => this.ompProcess, refreshState: () => this.refreshStateAfterActivity(), applyState: (state) => this.applyOmpState(state) };
  private disposed = false;
  private readonly indexNotify = new TrailingThrottle(500, () => this.notifyIndexChange());
  private readonly btw = new OmpBtwEventBridge();
  /** BTW 只借父进程，不走主 prompt/队列/abort 路径。 */
  readonly onBtwFrame = this.btw.subscribe;
  private readonly projectEvent = createEngineEventHandler({
    projection: () => this.projection,
    projector: () => this.projector,
    currentProcess: () => this.ompProcess,
    isCurrent: (process) => this.ompProcess === process,
    applyState: (state) => this.applyOmpState(state),
    flush: () => this.scheduleFlush(),
    onTerminalEnd: () => {
      this.promptTurns.onTerminalAgentEnd();
      this.scheduleFlush();
      void this.refreshStateAfterActivity();
    },
  });
  private resumeSessionPath: string | undefined;
  private followupMode: SessionConfigState["followupMode"] = "guide";
  private titleInitialized: boolean;
  /** prompt 轮收口与输入分发：经惰性宿主回写引擎状态。 */
  private readonly promptTurns = new EnginePromptTurnCloser({
    projection: () => this.projection,
    isStreaming: () => this.projector.isStreaming,
    followupMode: () => this.followupMode,
    ensureTitleFromText: (text) => {
      if (!this.titleInitialized && text.trim().length > 0) {
        this.titleInitialized = true;
        this.projection.setTitle(deriveTitle(text), "generated");
      }
    },
    ensureStarted: () => this.ensureOmpStarted(),
    currentProcess: () => this.ompProcess,
    flush: () => this.scheduleFlush(),
    // 惰性闭包读取：promptTurns 字段初始化早于构造体对 resolveSlashCommand 的赋值。
    resolveSlashCommand: (text) => (this.resolveSlashCommand ? this.resolveSlashCommand(text) : Promise.resolve({ kind: "dispatch" } as const)),
  });
  private readonly subagents: OmpSubagentBridge;
  constructor(init: EngineInit<ConversationEngine>) {
    this.sessionId = init.sessionId;
    this.workspaceId = init.workspaceId;
    this.workspacePath = init.workspacePath;
    this.ompFactory = init.ompFactory;
    this.resolveSlashCommand = init.resolveSlashCommand;
    this.forwardSubagentFrame = init.forwardSubagentFrame;
    this.gateway = init.gateway;
    this.onIndexChange = init.onIndexChange;
    this.onCommandsUpdate = init.onCommandsUpdate;
    this.commandOutputs = new OmpCommandOutputBridge({
      projection: () => this.projection,
      sessionPath: () => this.ompSessionFile,
      save: init.onCommandOutput,
      flush: init.flushCommandOutputs,
      scheduleFlush: () => this.scheduleFlush(),
      refresh: () => {
        void this.refreshStateAfterActivity();
      },
    });
    this.resumeSessionPath = init.resumeSessionPath;
    this.projection = new ConversationProjection(init.sessionId, init.viewIdOf);
    this.subagents = new OmpSubagentBridge(
      this.projection,
      () => this.ompProcess,
      () => this.scheduleFlush(),
    );
    this.projector = new OmpEventProjector(this.projection, { onCustomMessage: this.commandOutputs.custom });
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
    if (this.disposed) throw new Error("session closed");
    // 订阅冷会话会后台启动 omp（进程对象已创建但未 ready）；必须等待同一启动 promise。
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
  async loadSkillCommands(): Promise<unknown> {
    return readEngineSkillCommands(this.operationHost);
  }
  private async startOmp(): Promise<void> {
    await diagnostics.run({ sessionId: this.sessionId }, () =>
      startEngineProcess({
        workspacePath: this.workspacePath,
        ompFactory: this.ompFactory,
        resumeSessionPath: this.resumeSessionPath,
        interaction: this.interactionProxy,
        onEvent: (event) => this.handleOmpEvent(event),
        onExit: (code, process) => this.handleOmpExit(code, process),
        onCommandOutput: this.commandOutputs.emit,
        // prompt 响应/异步 prompt_result 的收口语义（A1，含 agentInvoked 判定）内聚在 promptTurns。
        onPromptResult: (frame) => this.promptTurns.onPromptResult(frame),
        onSessionInfoUpdate: ({ title }) => this.applySessionTitle(title),
        onConfigUpdate: ({ model, thinkingLevel }) => {
          this.projection.setModelConfig({ ...(model?.provider !== undefined ? { provider: model.provider } : {}), ...(model?.id !== undefined ? { model: model.id } : {}), ...(thinkingLevel !== undefined ? { thought: thinkingLevel } : {}) });
          this.notifyIndexChange();
          this.scheduleFlush();
        },
        onCommandsUpdate: this.onCommandsUpdate,
        onBtwFrame: this.btw.emit,
        onSubagentFrame: (frame) => {
          if (frame.type === "subagent_event") this.agentInteractions.ingest(frame.payload.id, frame.payload.event);
          this.subagents.handle(frame);
          this.forwardSubagentFrame?.(frame);
        },
        currentProcess: () => this.ompProcess,
        setProcess: (process) => {
          this.ompProcess = process;
          // 进程绑定不登记 ACK 为队列事实；取消输入门的 success 也可能没有真正入队。
        },
        bootstrap: (process) => this.bootstrapProcess(process),
      }),
    );
  }

  /** 进程启动后的首次状态水合（订阅可用性 + get_state + 子代理快照）。 */
  private async bootstrapProcess(process: OmpSessionProcess): Promise<void> {
    await runEngineOperation(this.operationHost, "omp.session.ready", () => process.start());
    // 关闭可在 ready/水合期间到达；不得继续给已销毁引擎写状态或重拉进程。
    if (this.disposed || this.ompProcess !== process) throw new Error("session closed during startup");
    this.projection.setSubagentAvailability(process.subagentSubscriptionAvailable === false ? "unavailable" : "ready");
    this.scheduleFlush();
    const state = await runEngineOperation(this.operationHost, "omp.session.hydrate", () => process.refreshState());
    if (this.disposed || this.ompProcess !== process) throw new Error("session closed during hydration");
    this.applyOmpState(state);
    await this.subagents.refresh(process);
  }
  applySessionTitle(title: string | undefined): void {
    if (title && title.trim().length > 0) {
      this.titleInitialized = true;
      this.projection.setTitle(title, "custom");
      this.notifyIndexChange();
      this.scheduleFlush();
    }
  }
  private refreshStateAfterActivity(): Promise<void> {
    return refreshEngineStateAfterActivity(
      this.ompProcess,
      (process) => !this.disposed && this.ompProcess === process,
      (state) => this.applyOmpState(state),
    );
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
    projectEngineContextWindow({ state, projection: this.projection, process: this.ompProcess, isCurrentProcess: (process) => this.ompProcess === process, onReport: () => this.scheduleFlush() });
    if (!this.titleInitialized && state.sessionName) {
      this.titleInitialized = true;
      this.projection.setTitle(state.sessionName, "generated");
    }
    this.notifyIndexChange();
    this.scheduleFlush();
  }
  handleOmpEvent(event: OmpSessionEventFrame): void {
    if (this.disposed) return;
    this.agentInteractions.ingest("$root", event);
    this.projectEvent(event);
  }
  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settleInteraction(interactionId: string, answer: HostUserInputAnswer): boolean {
    return this.interactionProxy.settle(interactionId, answer);
  }

  /** v4 snoozeInteractionAutoResolution：ask 首次交互暂停倒计时（omp ask_pause + 投影 snoozed）。 */
  snoozeInteractionAutoResolution(interactionId: string): boolean {
    const paused = this.interactionProxy.snooze(interactionId);
    this.projection.snoozeInteractionAutoResolution(interactionId);
    this.scheduleFlush();
    return paused;
  }
  handleOmpExit(code: number | null, process: OmpSessionProcess): void {
    if (this.ompProcess !== process) {
      diagnostics.debug("omp.session.stale_exit", { sessionId: this.sessionId, exitCode: code, reason: "process_fence" });
      return;
    }
    const beforeSeq = this.projection.seq;
    logSessionExit(this.projection, code, Boolean(process.ompSessionFile ?? this.resumeSessionPath), this.projector.isStreaming);
    // 崩溃时先保存 omp 进程的会话文件，供下次 --resume 使用。
    const exitedSessionFile = process.ompSessionFile;
    if (exitedSessionFile) this.resumeSessionPath = exitedSessionFile;
    this.ompProcess = null;
    this.btw.emit(null);
    const error = { code: "omp_process_exit", message: `omp core exited unexpectedly (code ${code ?? "null"})` };
    this.promptTurns.reset(error);
    diagnostics.run({ interactionDisposalStage: "process_exit" }, () => this.interactionProxy.dispose());
    this.projection.failAllTurns(error);
    logTurnTransitions(this.projection, beforeSeq, "process_exit");
    // 崩溃无 agent_end；必须在 exit 时清流式状态，避免重启前的输入误走 follow_up。
    this.projector.resetForRestart();
    this.scheduleFlush();
  }
  // ── 命令翻译 ──
  /** 发送用户输入；queue 仅在既有 owner 接纳，成功终态后逐项派发普通 prompt。
   * native guide 继续使用真实 steer；图片与临时模型随同一 payload 保留。 */
  async sendText(text: string, sourceCommandId: string, clientId: string, images: { type: "image"; data: string; mimeType: string }[] = [], modelSelection?: { provider: string; model: string; thought?: string }, originalText = text): Promise<"startNow" | "queue"> {
    return this.promptTurns.sendText(text, sourceCommandId, clientId, images, modelSelection, originalText);
  }
  async stop(): Promise<void> {
    const finishStop = this.promptTurns.beginStop();
    this.projector.noteStopRequested();
    this.scheduleFlush();
    try {
      await stopEngineOperation(this.operationHost, this.projection, () => this.scheduleFlush());
    } finally {
      finishStop();
    }
  }
  async compact(): Promise<void> {
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: "running" });
    this.scheduleFlush();
    const success = await applyEngineCompaction(this.operationHost);
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: success ? "success" : "failed" });
    this.scheduleFlush();
    // 失败标记可见后仍向调用方抛错，v4/legacy 都不能伪报压缩成功。
    if (!success) throw new Error("omp compaction failed");
  }
  async setAutoCompaction(enabled: boolean): Promise<{ error?: string }> {
    return applyEngineAutoCompaction(this.operationHost, enabled);
  }
  async setModel(provider: string, model: string, thought?: string): Promise<{ error?: string }> {
    return applyEngineSetModel(this.operationHost, { provider, model, thought });
  }

  /** guide/queue 均接受；guide 走真实 steer，queue 由同一 owner 轮后派发。 */
  setFollowupMode(mode: SessionConfigState["followupMode"]): void {
    this.followupMode = mode;
    this.projection.setModelConfig({ followupMode: mode });
    this.scheduleFlush();
  }
  setAutoDrain(autoDrain: boolean): void {
    this.promptTurns.setAutoDrain(autoDrain);
  }
  queueItemAction(action: "delete" | "interject", queueItemId: string): QueueItemActionResult {
    return this.promptTurns.queueItemAction(action, queueItemId);
  }
  async setThoughtLevel(level: string): Promise<{ error?: string }> {
    return applyEngineThoughtLevel(this.operationHost, level);
  }

  async rename(title: string): Promise<void> {
    // 原先先改投影再忽略核心失败，会把忙时拒绝与冷恢复改名伪报成功。
    if (this.ompProcess || this.resumeSessionPath) {
      await this.ensureOmpStarted();
      const process = this.ompProcess;
      const outcome = process ? await diagnostics.run({ sessionId: this.sessionId }, () => diagnosticSessionCommand(process, { type: "set_session_name", name: title })) : undefined;
      if (!outcome?.success) throw new Error(outcome?.error ?? "set_session_name failed");
    }
    this.applySessionTitle(title);
  }

  /** 子代理控制/详情续读的进程面（subagentControl.ts 消费，结构化窄视图避免成环）。 */
  subagentProcessHost() {
    return { ensureStarted: () => this.ensureOmpStarted(), currentProcess: () => this.ompProcess, observedSubagentStatus: (id: string, process: OmpSessionProcess | null) => this.subagents.observedSubagentStatus(id, process) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.indexNotify.dispose();
    this.publisher.dispose();
    this.interactionProxy.dispose();
    this.promptTurns.reset({ code: "session_closed", message: "session closed" });
    const process = this.ompProcess;
    this.ompProcess = null;
    this.btw.dispose();
    await process?.dispose();
    await this.ompStarting?.catch(() => diagnostics.warn("omp.session.dispose.start_failed", { sessionId: this.sessionId, failureStage: "pending_start" }));
    await this.commandOutputs.flush();
  }

  /** 删除前仅释放文件占用；磁盘删除失败时仍可用原投影和订阅重新启动。 */
  async preparePermanentDeletion(): Promise<string | null> {
    this.promptTurns.reset({ code: "session_delete", message: "session stopped for deletion" });
    await this.ompStarting?.catch(() => diagnostics.warn("omp.session.delete.start_failed", { sessionId: this.sessionId, failureStage: "pending_start" }));
    const process = this.ompProcess;
    this.resumeSessionPath = process?.ompSessionFile ?? this.resumeSessionPath;
    const persistedPath = this.resumeSessionPath ?? null;
    this.ompProcess = null;
    await process?.dispose();
    await this.commandOutputs.flush();
    if (process) this.projection.failAllTurns({ code: "session_delete", message: "session stopped for deletion" });
    this.scheduleFlush();
    return persistedPath;
  }

  subscribe(params: SubscribeOptions): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    const ack = this.publisher.subscribe(params);
    // 冷历史先到 UI；已保存会话再后台恢复 omp，get_state 会把真实上下文和自动压缩状态投影给同一订阅。
    if (this.resumeSessionPath) void this.ensureOmpStarted().catch(() => diagnostics.warn("omp.session.restore.failed", { sessionId: this.sessionId, failureStage: "background_restore" }));
    return ack;
  }

  unsubscribe(subscriptionId: string): void {
    this.publisher.unsubscribe(subscriptionId);
  }
  setConnectionFlowState(connectionId: string, state: "saturated" | "drained" | "closed"): void {
    this.publisher.setConnectionFlowState(connectionId, state);
  }
  resync(subscriptionId: string, base: { logEpoch: string; seq: number } | null, forceSnapshot = false): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    return this.publisher.resync(subscriptionId, base, forceSnapshot);
  }
  scheduleFlush(): void {
    if (this.disposed) return;
    this.publisher.scheduleFlush(() => this.indexNotify.ping());
  }
  private notifyIndexChange(): void {
    if (this.disposed) return;
    this.onIndexChange(this);
  }

  /** 冷恢复水合（订阅建立前，不产生 delta）；merge=true 为只读详情视图的事件驱动重水合：幂等合并并产生增量下发。 */
  hydrateRows(rows: ConversationRow[], merge = false, times?: { createdAt?: number; updatedAt?: number }): void {
    if (!merge && times) this.historyClock.restore(times);
    if (merge) this.projection.mergeRows(rows);
    else this.projection.hydrateRows(rows);
    this.scheduleFlush();
  }
  /** 只读子代理记录 reset：沿用同一订阅与水位交付替换屏障。 */
  replaceHydratedRows(rows: ConversationRow[]): void {
    this.projection.replaceHydratedRows(rows);
    this.scheduleFlush();
  }
}
