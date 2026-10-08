// ConversationEngine：一个 ZCode 会话 = 一个投影 + 一个（惰性启动的）omp 子进程。
// 职责：omp 事件 → 投影 → 订阅者帧；v4 命令到 omp 命令的翻译入口；交互请求代理。
import type { ConversationRow, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../domain/conversationProjection.js";
import { OmpEventProjector } from "../domain/ompProjector.js";
import type { OmpSessionEventFrame, OmpStateData } from "../domain/ompFrames.js";
import type { HostGateway, HostUserInputAnswer, OmpProcessFactory, OmpSessionProcess } from "./ports.js";
import { ConversationTopicPublisher, type SubscribeOptions } from "./topicPublisher.js";
import { OmpInteractionProxy } from "./ompInteractionProxy.js";
import { applyEngineAutoCompaction, applyEngineCompaction, applyEngineSetModel, applyEngineThoughtLevel, projectEngineContextWindow, readOmpSkillCommands, startEngineProcess, createEngineEventHandler } from "./ompEngineProcess.js";
import { PromptQueueReconciler } from "./promptQueueReconciler.js";
import { registerQueueDispatchAckSink, type SlashCommandResolver } from "./ompPromptDispatch.js";
import { EnginePromptTurnCloser } from "./promptTurnCloser.js";
import { TrailingThrottle } from "./trailingThrottle.js";
import { deriveTitle } from "../domain/titleText.js";
import { OmpSubagentBridge } from "./ompSubagentBridge.js";
import type { EngineInit } from "./engineInit.js";
import { OmpBtwEventBridge } from "./OmpBtwEventBridge.js";
import { OmpAgentInteractionLog } from "../domain/OmpAgentInteractionLog.js";
export class ConversationEngine {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly projection: ConversationProjection;
  readonly projector: OmpEventProjector;
  readonly agentInteractions = new OmpAgentInteractionLog();
  private readonly ompFactory: OmpProcessFactory | undefined;
  private readonly gateway: HostGateway;
  private readonly onIndexChange: (engine: ConversationEngine) => void;
  private readonly onCommandsUpdate: ((commands: unknown) => void) | undefined;
  private readonly resolveSlashCommand: SlashCommandResolver | undefined;
  private readonly forwardSubagentFrame: ((frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void) | undefined;
  private readonly publisher: ConversationTopicPublisher;
  private readonly interactionProxy: OmpInteractionProxy;
  private ompProcess: OmpSessionProcess | null = null;
  private ompStarting: Promise<void> | null = null;
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
      void this.queueReconciler.refreshAfterActivity({ graceRecheckAfter: true });
    },
  });
  private resumeSessionPath: string | undefined;
  private followupMode: SessionConfigState["followupMode"] = "queue";
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
    markSteerInFlight: (sourceCommandId) => this.queueReconciler.markSteerInFlight(sourceCommandId),
    clearSteerInFlight: () => this.queueReconciler.clearSteerInFlight(),
    noteInputAccepted: () => this.queueReconciler.noteInputAccepted(),
    ensureStarted: () => this.ensureOmpStarted(),
    currentProcess: () => this.ompProcess,
    flush: () => this.scheduleFlush(),
    // 惰性闭包读取：promptTurns 字段初始化早于构造体对 resolveSlashCommand 的赋值。
    resolveSlashCommand: (text) => (this.resolveSlashCommand ? this.resolveSlashCommand(text) : Promise.resolve({ kind: "dispatch" } as const)),
  });
  private readonly subagents: OmpSubagentBridge;
  /** A3/A5：队列对账（get_state 回读判定 + debounce）与 steer 在途标记的协调器。 */
  private readonly queueReconciler: PromptQueueReconciler;
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
    this.resumeSessionPath = init.resumeSessionPath;
    this.projection = new ConversationProjection(init.sessionId, init.viewIdOf);
    this.subagents = new OmpSubagentBridge(
      this.projection,
      () => this.ompProcess,
      () => this.scheduleFlush(),
    );
    // A5：在途 steer 的 guide 轮（sourceCommandId 与当前活跃轮一致）在 terminal agent_end
    // 收口时转回 queuedTurns，等下一个 agent_start 激活承接 drain 输出；A3：queue_update 事件
    // 是队列对账触发点之一（debounce 后回读 get_state）。两者内聚在 PromptQueueReconciler（含 XR1 竞态守卫）。
    this.queueReconciler = new PromptQueueReconciler({
      projection: this.projection,
      currentProcess: () => this.ompProcess,
      isCurrentProcess: (process) => this.ompProcess === process,
      applyState: (state) => this.applyOmpState(state),
      isStreaming: () => this.projector.isStreaming,
      scheduleFlush: () => this.scheduleFlush(),
    });
    this.projector = new OmpEventProjector(this.projection, { steerGuideCommandId: () => this.queueReconciler.steerGuideCommandIdOf(), onQueueUpdate: () => this.queueReconciler.scheduleQueueReconciliation() });
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
    await this.ensureOmpStarted();
    return readOmpSkillCommands(this.ompProcess!);
  }
  private async startOmp(): Promise<void> {
    await startEngineProcess({
      workspacePath: this.workspacePath,
      ompFactory: this.ompFactory,
      resumeSessionPath: this.resumeSessionPath,
      interaction: this.interactionProxy,
      onEvent: (event) => this.handleOmpEvent(event),
      onExit: (code, process) => this.handleOmpExit(code, process),
      onCommandOutput: ({ text }) => {
        if (!this.projector.isStreaming) this.projection.activateQueuedTurn();
        this.projection.appendAssistantText(text);
        this.scheduleFlush();
      },
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
        // F2b-P1 接线：steer/follow_up 分发 success ACK ⇒ 文本已入 omp 队列（v18.4.8 上
        // rpc handler 在 await followUp()/steer() 后才回 ACK），到达即把分发文本登记为
        // seen，消除「停止边界 drain 快于 250ms debounce、快照从未携带」窗口的宽限误判
        // interrupted（语义与边界备查见 PromptQueueReconciler.noteDispatchAckSeen）。
        if (process) {
          registerQueueDispatchAckSink(process, (text) => this.queueReconciler.noteDispatchAckSeen(text));
        }
      },
      bootstrap: (process) => this.bootstrapProcess(process),
    });
  }

  /** 进程启动后的首次状态水合（订阅可用性 + get_state + 子代理快照）。 */
  private async bootstrapProcess(process: OmpSessionProcess): Promise<void> {
    await process.start();
    // 关闭可在 ready/水合期间到达；不得继续给已销毁引擎写状态或重拉进程。
    if (this.disposed || this.ompProcess !== process) throw new Error("session closed during startup");
    this.projection.setSubagentAvailability(process.subagentSubscriptionAvailable === false ? "unavailable" : "ready");
    this.scheduleFlush();
    const state = await process.refreshState();
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
    if (this.ompProcess !== process) return;
    // 崩溃时先保存 omp 进程的会话文件，供下次 --resume 使用。
    const exitedSessionFile = process.ompSessionFile;
    if (exitedSessionFile) this.resumeSessionPath = exitedSessionFile;
    this.ompProcess = null;
    this.btw.emit(null);
    this.promptTurns.reset();
    // A5/A3 状态随进程终结：在途 steer 标记与挂起的对账不再有意义（failAllTurns 已收口）。
    this.queueReconciler.dispose();
    this.interactionProxy.dispose();
    const error = { code: "omp_process_exit", message: `omp core exited unexpectedly (code ${code ?? "null"})` };
    this.projection.failAllTurns(error);
    // 崩溃无 agent_end；必须在 exit 时清流式状态，避免重启前的输入误走 follow_up。
    this.projector.resetForRestart();
    this.scheduleFlush();
  }
  // ── 命令翻译 ──
  /** 发送用户输入；返回实际 delivery（omp 流式中转为 follow_up 队列）。图片附件直接进 omp prompt。
   *  完整 dispatch 流程（排队/steer 在途标记与失败收口）在 promptTurnCloser。 */
  async sendText(text: string, sourceCommandId: string, clientId: string, images: { type: "image"; data: string; mimeType: string }[] = [], modelSelection?: { provider: string; model: string; thought?: string }, originalText = text): Promise<"startNow" | "queue"> {
    return this.promptTurns.sendText(text, sourceCommandId, clientId, images, modelSelection, originalText);
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
      () => this.ensureOmpStarted(),
      () => this.ompProcess,
      () => this.queueReconciler.refreshAfterActivity(),
    );
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: success ? "success" : "failed" });
    this.scheduleFlush();
    // 失败标记可见后仍向调用方抛错，v4/legacy 都不能伪报压缩成功。
    if (!success) throw new Error("omp compaction failed");
  }
  async setAutoCompaction(enabled: boolean): Promise<{ error?: string }> {
    return applyEngineAutoCompaction(
      enabled,
      () => this.ensureOmpStarted(),
      () => this.ompProcess,
      (state) => this.applyOmpState(state),
    );
  }
  async setModel(provider: string, model: string, thought?: string): Promise<{ error?: string }> {
    return applyEngineSetModel(
      { provider, model, thought },
      () => this.ensureOmpStarted(),
      () => this.ompProcess,
    );
  }

  /** guide/queue 均接受；实际路由在 sendText 流式分支（guide→steer、queue→follow_up）。 */
  setFollowupMode(mode: SessionConfigState["followupMode"]): void {
    this.followupMode = mode;
    this.projection.setModelConfig({ followupMode: mode });
    this.scheduleFlush();
  }

  async setThoughtLevel(level: string): Promise<{ error?: string }> {
    return applyEngineThoughtLevel(
      level,
      () => this.ensureOmpStarted(),
      () => this.ompProcess,
    );
  }

  async rename(title: string): Promise<void> {
    // 原先先改投影再忽略核心失败，会把忙时拒绝与冷恢复改名伪报成功。
    if (this.ompProcess || this.resumeSessionPath) {
      await this.ensureOmpStarted();
      const outcome = await this.ompProcess?.send({ type: "set_session_name", name: title });
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
    // A3：销毁时清理挂起的对账定时器，避免引擎销毁后仍触发 get_state。
    this.queueReconciler.dispose();
    const process = this.ompProcess;
    this.ompProcess = null;
    this.btw.dispose();
    await process?.dispose();
    await this.ompStarting?.catch(() => {});
  }

  /** 删除前仅释放文件占用；磁盘删除失败时仍可用原投影和订阅重新启动。 */
  async preparePermanentDeletion(): Promise<string | null> {
    await this.ompStarting?.catch(() => {});
    const process = this.ompProcess;
    if (!process) return this.resumeSessionPath ?? null;
    this.resumeSessionPath = process.ompSessionFile ?? this.resumeSessionPath;
    const persistedPath = this.resumeSessionPath ?? null;
    this.ompProcess = null;
    await process.dispose();
    this.projection.failAllTurns({ code: "session_delete", message: "session stopped for deletion" });
    this.scheduleFlush();
    return persistedPath;
  }

  subscribe(params: SubscribeOptions): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    const ack = this.publisher.subscribe(params);
    // 冷历史先到 UI；已保存会话再后台恢复 omp，get_state 会把真实上下文和自动压缩状态投影给同一订阅。
    if (this.resumeSessionPath) void this.ensureOmpStarted().catch(() => {});
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
  hydrateRows(rows: ConversationRow[], merge = false): void {
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
