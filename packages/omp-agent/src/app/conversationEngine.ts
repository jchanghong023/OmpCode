// ConversationEngine：一个 ZCode 会话 = 一个投影 + 一个（惰性启动的）omp 子进程。
// 职责：omp 事件 → 投影 → 订阅者帧；v4 命令到 omp 命令的翻译入口；交互请求代理。
// 订阅/帧发布实现在 topicPublisher.ts。

import type { ConversationRow, PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../domain/conversationProjection.js";
import { OmpEventProjector } from "../domain/ompProjector.js";
import { createId, createInteractionId } from "../domain/ids.js";
import type { OmpSessionEventFrame, OmpStateData } from "../domain/ompFrames.js";
import type { HostGateway, HostUserInputAnswer, OmpProcessFactory, OmpSessionProcess, OmpUiRequest } from "./ports.js";
import { ConversationTopicPublisher, type SubscribeOptions } from "./topicPublisher.js";

export interface EngineInit {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  ompFactory: OmpProcessFactory;
  gateway: HostGateway;
  onIndexChange: (engine: ConversationEngine) => void;
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
  private readonly publisher: ConversationTopicPublisher;
  private ompProcess: OmpSessionProcess | null = null;
  private ompStarting: Promise<void> | null = null;
  private lastIndexActivity = 0;
  private resumeSessionPath: string | undefined;
  private titleInitialized: boolean;

  constructor(init: EngineInit) {
    this.sessionId = init.sessionId;
    this.workspaceId = init.workspaceId;
    this.workspacePath = init.workspacePath;
    this.ompFactory = init.ompFactory;
    this.gateway = init.gateway;
    this.onIndexChange = init.onIndexChange;
    this.resumeSessionPath = init.resumeSessionPath;
    this.projection = new ConversationProjection(init.sessionId);
    this.projector = new OmpEventProjector(this.projection);
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
    if (this.ompProcess) {
      return;
    }
    if (!this.ompStarting) {
      this.ompStarting = this.startOmp().finally(() => {
        this.ompStarting = null;
      });
    }
    await this.ompStarting;
  }

  private async startOmp(): Promise<void> {
    const process = this.ompFactory.create({
      cwd: this.workspacePath,
      resumeSessionPath: this.resumeSessionPath,
      onEvent: (event) => this.handleOmpEvent(event),
      onUiRequest: (request) => void this.handleOmpUiRequest(request),
      onExit: (code) => this.handleOmpExit(code),
    });
    this.ompProcess = process;
    await process.start();
    const state = await process.refreshState();
    this.applyOmpState(state);
  }

  private applyOmpState(state: OmpStateData | null): void {
    if (!state) {
      return;
    }
    this.projection.setModelConfig({
      ...(state.model?.provider !== undefined ? { provider: state.model.provider } : {}),
      ...(state.model?.id !== undefined ? { model: state.model.id } : {}),
      ...(state.thinkingLevel !== undefined ? { thought: state.thinkingLevel } : {}),
    });
    if (state.contextUsage && typeof state.contextUsage.contextWindow === "number") {
      this.projection.setContextWindow(state.contextUsage.tokens ?? 0, state.contextUsage.contextWindow);
    }
    if (!this.titleInitialized && state.sessionName) {
      this.titleInitialized = true;
      this.projection.setTitle(state.sessionName, "generated");
    }
    this.notifyIndexChange();
    this.scheduleFlush();
  }

  private handleOmpEvent(event: OmpSessionEventFrame): void {
    this.projector.handleEvent(event);
    this.scheduleFlush();
  }

  private handleOmpExit(code: number | null): void {
    this.ompProcess = null;
    if (this.projection.stateSnapshot.control.phase === "running") {
      const error = { code: "omp_process_exit", message: `omp core exited unexpectedly (code ${code ?? "null"})` };
      this.projection.recordTurnError(error);
      this.projection.finishTurn("failed", error);
      this.scheduleFlush();
    }
  }

  // ── omp 交互请求 → ZCode pendingInteraction + 宿主反向请求 ──
  // 解析有两条汇入路径：宿主直接应答反向请求，或 UI 经 v4 resolveInteraction 命令回执；
  // 两者汇合到同一个 deferred，先到先用；180s 兜底取消（对齐 ZCode CLI 侧交互超时口径）。
  private interactions = new Map<
    string,
    {
      ompRequestId: string;
      resolve: (answer: HostUserInputAnswer) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private async handleOmpUiRequest(request: OmpUiRequest): Promise<void> {
    const method = request.frame.method;
    if (method !== "select" && method !== "confirm" && method !== "input") {
      // omp 的状态类 UI 事件与 open_url 在适配层没有宿主呈现面，按取消回执，不让 omp 挂起。
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    const interactionId = createInteractionId();
    const prompt = request.frame.message ?? request.frame.prompt ?? request.frame.title ?? "";
    const options = request.frame.options?.map((option) => ({ optionId: option, label: option }));
    const pending: PendingInteraction = {
      interactionId,
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt,
        freeText: method === "input",
        ...(options ? { options } : {}),
      },
    };
    this.projection.addPendingInteraction(pending);
    this.scheduleFlush();
    const answer = await new Promise<HostUserInputAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.interactions.delete(interactionId);
        resolve({ action: "cancel" });
      }, 180_000);
      timer.unref?.();
      this.interactions.set(interactionId, { ompRequestId: request.frame.id, resolve, timer });
      this.gateway
        .requestUserInput({
          requestId: interactionId,
          sessionId: this.sessionId,
          prompt,
          ...(options ? { options } : {}),
        })
        .then((hostAnswer) => this.settleInteraction(interactionId, hostAnswer))
        .catch(() => this.settleInteraction(interactionId, { action: "cancel" }));
    });
    this.projection.resolvePendingInteraction(interactionId);
    this.scheduleFlush();
    request.respond(this.toOmpUiResponse(request, answer));
  }

  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settleInteraction(interactionId: string, answer: HostUserInputAnswer): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry) {
      return false;
    }
    this.interactions.delete(interactionId);
    clearTimeout(entry.timer);
    entry.resolve(answer);
    return true;
  }

  private toOmpUiResponse(request: OmpUiRequest, answer: HostUserInputAnswer) {
    if (answer.action === "cancel") {
      return { type: "extension_ui_response" as const, id: request.frame.id, cancelled: true as const };
    }
    if (request.frame.method === "confirm") {
      return { type: "extension_ui_response" as const, id: request.frame.id, confirmed: answer.action === "accept" };
    }
    if (request.frame.options && request.frame.options.length > 0) {
      if (answer.action === "decline") {
        const deny = request.frame.options.find((option) => /^deny$/i.test(option)) ?? request.frame.options.at(-1) ?? "Deny";
        return { type: "extension_ui_response" as const, id: request.frame.id, value: deny };
      }
      const selected = answer.optionId ?? request.frame.options[0]!;
      return { type: "extension_ui_response" as const, id: request.frame.id, value: selected };
    }
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      value: answer.action === "accept" ? answer.freeText ?? "" : "",
    };
  }

  // ── 命令翻译 ──
  /** 发送用户输入；返回实际 delivery（omp 流式中转为 follow_up 队列）。图片附件直接进 omp prompt。 */
  async sendText(
    text: string,
    sourceCommandId: string,
    clientId: string,
    images: { type: "image"; data: string; mimeType: string }[] = [],
  ): Promise<"startNow" | "queue"> {
    if (!this.titleInitialized && text.trim().length > 0) {
      this.titleInitialized = true;
      this.projection.setTitle(deriveTitle(text), "generated");
    }
    const inputId = createId("input");
    this.projection.beginUserTurn({ text, inputId, sourceCommandId, clientId });
    this.scheduleFlush();
    const streaming = this.projector.isStreaming;
    try {
      await this.ensureOmpStarted();
    } catch (error) {
      this.failTurn("omp_start_failed", error);
      return streaming ? "queue" : "startNow";
    }
    const process = this.ompProcess;
    if (!process) {
      this.failTurn("omp_unavailable", new Error("omp core failed to start"));
      return streaming ? "queue" : "startNow";
    }
    const outcome = await process.send(
      streaming
        ? { type: "follow_up", message: text, ...(images.length > 0 ? { images } : {}) }
        : { type: "prompt", message: text, ...(images.length > 0 ? { images } : {}) },
    );
    if (!outcome.success) {
      this.failTurn("omp_prompt_failed", new Error(outcome.error ?? "prompt rejected"));
      return streaming ? "queue" : "startNow";
    }
    return streaming ? "queue" : "startNow";
  }

  private failTurn(code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.projection.recordTurnError({ code, message });
    this.projection.finishTurn("failed", { code, message });
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
    let success = false;
    try {
      await this.ensureOmpStarted();
      const outcome = await this.ompProcess?.send({ type: "compact" });
      success = outcome?.success === true;
    } catch {
      success = false;
    }
    this.projection.addTimelineMarker({ type: "compact", origin: "manual", status: success ? "success" : "failed" });
    this.scheduleFlush();
  }

  async setModel(provider: string, model: string, thought?: string): Promise<{ error?: string }> {
    try {
      await this.ensureOmpStarted();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const process = this.ompProcess;
    if (!process) {
      return { error: "omp core failed to start" };
    }
    const outcome = await process.send({ type: "set_model", provider, modelId: model });
    if (!outcome.success) {
      return { error: outcome.error ?? "set_model failed" };
    }
    if (thought && thought !== "off") {
      await process.send({ type: "set_thinking_level", level: thought });
    }
    return {};
  }

  async setThoughtLevel(level: string): Promise<{ error?: string }> {
    try {
      await this.ensureOmpStarted();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const outcome = await this.ompSessionSend({ type: "set_thinking_level", level });
    return outcome?.success ? {} : { error: outcome?.error ?? "set_thinking_level failed" };
  }

  private async ompSessionSend(command: Parameters<OmpSessionProcess["send"]>[0]) {
    return this.ompProcess?.send(command) ?? { success: false, error: "omp core not running" };
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
    this.publisher.dispose();
    for (const entry of this.interactions.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ action: "cancel" });
    }
    this.interactions.clear();
    const process = this.ompProcess;
    this.ompProcess = null;
    await process?.dispose();
  }

  // ── 订阅与帧（实现在 topicPublisher）──
  subscribe(params: SubscribeOptions): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    return this.publisher.subscribe(params);
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
    this.publisher.scheduleFlush(() => {
      const now = Date.now();
      if (now - this.lastIndexActivity > 500) {
        this.lastIndexActivity = now;
        this.notifyIndexChange();
      }
    });
  }

  private notifyIndexChange(): void {
    this.onIndexChange(this);
  }

  /** 冷恢复：把历史行放入投影（订阅建立前调用）。 */
  hydrateRows(rows: ConversationRow[]): void {
    this.projection.hydrateRows(rows);
  }
}

export function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}
