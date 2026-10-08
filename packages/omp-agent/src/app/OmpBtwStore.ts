import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandAck,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../domain/conversationProjection.js";
import {
  btwRows,
  btwViewId,
  latestBtwTurn,
  ompBtwHistorySchema,
  ompBtwResponseSchema,
  ompBtwCancelSchema,
  parseBtwViewId,
} from "../domain/OmpBtwFrames.js";
import type { OmpBtwFrame, OmpBtwRecord } from "../domain/OmpBtwFrames.js";
import { createId } from "../domain/ids.js";
import type { ConversationEngine } from "./conversationEngine.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { HostGateway, OmpSessionProcess, OmpCommandOutcome } from "./ports.js";
import { ConversationTopicPublisher, type SubscribeOptions } from "./topicPublisher.js";
import { ProtocolError } from "./errors.js";

interface SideView {
  parent: string;
  recordId: string | null;
  record: OmpBtwRecord | null;
  projection: ConversationProjection;
  publisher: ConversationTopicPublisher;
  sources: Map<number, string>;
}
export class OmpBtwStore {
  private readonly views = new Map<string, SideView>();
  private readonly parents = new Map<
    string,
    { engine: ConversationEngine; off: () => void; serial: number }
  >();
  constructor(
    private readonly deps: {
      registry: SessionRegistry;
      gateway: HostGateway;
      workspaceId: string;
      workspacePath: string;
    },
  ) {}

  getView(id: string): SideView | null {
    return this.views.get(id) ?? null;
  }

  owns(id: string): boolean {
    return parseBtwViewId(id) !== null;
  }

  async subscribe(id: string, options: SubscribeOptions) {
    const view = await this.acquire(id);
    return view.publisher.subscribe(options);
  }

  private async parent(id: string): Promise<ConversationEngine> {
    const engine =
      this.deps.registry.getEngine(id) ??
      (await this.deps.registry.resumeSession({
        sessionId: id,
        workspaceId: this.deps.workspaceId,
        workspacePath: this.deps.workspacePath,
      }));
    const previous = this.parents.get(id);
    if (previous?.engine !== engine) {
      previous?.off();
      const owner = { engine, serial: 0, off: () => {} };
      owner.off = engine.onBtwFrame((frame) => {
        if (this.parents.get(id) !== owner) return;
        owner.serial++;
        this.onFrame(id, frame);
      });
      this.parents.set(id, owner);
    }
    await engine.ensureOmpStarted();
    return engine;
  }

  private makeView(
    id: string,
    parent: string,
    recordId: string | null,
    config: SessionConfigState,
  ): SideView {
    const projection = new ConversationProjection(id);
    const view = {
      parent,
      recordId,
      record: null,
      projection,
      publisher: new ConversationTopicPublisher(id, projection, this.deps.gateway),
      sources: new Map<number, string>(),
    };
    this.views.set(id, view);
    projection.patchSideViewState({
      config,
      availability: {
        ...projection.stateSnapshot.availability,
        compact: { allowed: false, reasonCode: "fault.command.sideSessionUnsupported" },
        switchModelConfig: { allowed: false, reasonCode: "fault.command.sideSessionParentModel" },
        setFollowupMode: { allowed: false, reasonCode: "fault.command.sideSessionUnsupported" },
      },
    });
    return view;
  }

  private project(view: SideView, record: OmpBtwRecord, config?: SessionConfigState): void {
    view.record = record;
    view.projection.mergeRows(btwRows(record, view.sources));
    const latest = latestBtwTurn(record);
    const running = latest.status === "running";
    view.projection.patchSideViewState({
      ...(config ? { config } : {}),
      control: {
        ...view.projection.stateSnapshot.control,
        phase: running
          ? "running"
          : latest.status === "complete"
            ? "completedSuccess"
            : latest.status === "error"
              ? "error"
              : "completedInterrupted",
        canStop: running,
        stopState: running ? "stoppable" : "idle",
        stopTargetKind: "assistant",
        sessionEnded: !running,
        lastError:
          latest.status === "error" || latest.status === "interrupted"
            ? {
                code: `side_${latest.status}`,
                message: latest.error ?? latest.status,
                recoverable: true,
                at: Date.now(),
                source: "runtime",
              }
            : null,
      },
      inputRouting: running
        ? { mode: "reject", reasonCode: "fault.command.sideSessionRunning" }
        : { mode: "startNow" },
    });
    view.publisher.scheduleFlush(() => {});
  }

  private onFrame(parent: string, frame: OmpBtwFrame | null): void {
    if (!frame) {
      for (const view of this.views.values())
        if (
          view.parent === parent &&
          view.record &&
          latestBtwTurn(view.record).status === "running"
        ) {
          const latest = latestBtwTurn(view.record);
          const interrupted = {
            ...latest,
            status: "interrupted" as const,
            error: "omp core exited during side question",
          };
          this.project(
            view,
            view.record.followUps?.length
              ? { ...view.record, followUps: [...view.record.followUps.slice(0, -1), interrupted] }
              : { ...view.record, ...interrupted },
          );
        }
      return;
    }
    if (frame.type === "btw_record") {
      const id = btwViewId(parent, frame.record.id);
      if (!this.views.has(id)) {
        const engine = this.parents.get(parent)!.engine;
        this.makeView(id, parent, frame.record.id, engine.projection.stateSnapshot.config);
      }
    }
    for (const view of this.views.values()) {
      if (view.parent !== parent) continue;
      if (frame.type === "notice") {
        view.projection.patchSideViewState({
          control: {
            ...view.projection.stateSnapshot.control,
            lastError: {
              code: "side_history_save",
              message: frame.message,
              recoverable: true,
              at: Date.now(),
              source: "runtime",
            },
          },
        });
        view.publisher.scheduleFlush(() => {});
      } else if (frame.type === "btw_record" && view.recordId === frame.record.id) {
        this.project(view, frame.record);
      } else if (frame.type === "btw_delta" && view.recordId === frame.recordId && view.record) {
        const latest = latestBtwTurn(view.record);
        if (latest.status !== "running") continue;
        const next = { ...latest, answer: latest.answer + frame.delta };
        this.project(
          view,
          view.record.followUps?.length
            ? { ...view.record, followUps: [...view.record.followUps.slice(0, -1), next] }
            : { ...view.record, ...next },
        );
      }
    }
  }

  private failure(outcome: OmpCommandOutcome): never {
    const missing = /unknown command|unsupported|not supported/i.test(outcome.error ?? "");
    throw new ProtocolError(
      missing ? -32601 : -32000,
      `${missing ? "fault.command.sideSessionCapabilityMissing: " : ""}${outcome.error ?? "BTW command failed"}`,
    );
  }

  private async history(parentId: string): Promise<string[]> {
    const engine = await this.parent(parentId);
    const host = engine.subagentProcessHost();
    const process = host.currentProcess()!;
    const serial = this.parents.get(parentId)!.serial;
    const outcome = await process.send({ type: "get_btw_history" });
    if (host.currentProcess() !== process)
      throw new ProtocolError(-32000, "side session process changed");
    if (!outcome.success) this.failure(outcome);
    const records = ompBtwHistorySchema.parse(outcome.data).records;
    return records.map((record) => {
      const id = btwViewId(parentId, record.id);
      const view =
        this.views.get(id) ??
        this.makeView(id, parentId, record.id, engine.projection.stateSnapshot.config);
      // 读取期间收到事件时，不用旧快照覆盖更晚的 live record。
      if (this.parents.get(parentId)!.serial === serial || !view.record)
        this.project(view, record, engine.projection.stateSnapshot.config);
      return id;
    });
  }

  async acquire(id: string): Promise<SideView> {
    const parsed = parseBtwViewId(id);
    if (!parsed) throw new ProtocolError(-32602, "invalid side session address");
    if (parsed.record.startsWith("draft-")) {
      const existing = this.views.get(id);
      if (existing) return existing;
      const engine = await this.parent(parsed.parent);
      return this.makeView(id, parsed.parent, null, engine.projection.stateSnapshot.config);
    }
    const ids = await this.history(parsed.parent);
    if (!ids.includes(id))
      throw new ProtocolError(-32004, "fault.command.sessionNotFound: side topic missing");
    return this.views.get(id)!;
  }

  async create(
    parentId: string,
    payload: CommandPayloadMap["createSelectionSideSession"],
    envelope: CommandEnvelope,
  ): Promise<NonNullable<CommandAck["result"]>> {
    if (payload.restoreSaved && payload.firstInput)
      throw new ProtocolError(-32602, "history discovery cannot send input");
    if (payload.restoreSaved) {
      const sideSessionIds = await this.history(parentId);
      if (!sideSessionIds.length) throw new ProtocolError(-32004, "no saved side questions");
      return { type: "createSelectionSideSession", sessionId: sideSessionIds[0]!, sideSessionIds };
    }
    // 能力由真实只读 RPC 确认；空 pane 不发模型请求。
    await this.history(parentId);
    const engine = await this.parent(parentId);
    const id = btwViewId(parentId, createId("draft"));
    this.makeView(id, parentId, null, engine.projection.stateSnapshot.config);
    if (payload.firstInput) return this.send(id, payload.firstInput, envelope);
    return { type: "createSelectionSideSession", sessionId: id };
  }

  async send(
    id: string,
    payload: Pick<CommandPayloadMap["sendText"], "text" | "modelSelection" | "attachments">,
    envelope: CommandEnvelope,
  ): Promise<NonNullable<CommandAck["result"]>> {
    if (!payload.text.trim()) throw new ProtocolError(-32602, "side question must not be empty");
    if (payload.attachments?.length)
      throw new ProtocolError(-32602, "side questions do not support attachments");
    const view = this.views.get(id) ?? (await this.acquire(id));
    const engine = await this.parent(view.parent);
    const config = engine.projection.stateSnapshot.config;
    const selection = payload.modelSelection;
    if (
      selection &&
      (selection.providerId !== config.provider ||
        selection.modelId !== config.model ||
        (selection.options?.reasoningLevel !== undefined &&
          selection.options.reasoningLevel !== config.thought))
    ) {
      throw new ProtocolError(
        -32602,
        "fault.command.sideSessionParentModel: side questions use the parent model",
      );
    }
    const host = engine.subagentProcessHost();
    const process: OmpSessionProcess = host.currentProcess()!;
    const serial = this.parents.get(view.parent)!.serial;
    const outcome = await process.send({
      type: "btw",
      question: payload.text,
      ...(view.recordId ? { recordId: view.recordId } : {}),
    });
    if (host.currentProcess() !== process)
      throw new ProtocolError(
        -32000,
        "side session process changed after admission; recover history",
      );
    if (!outcome.success) this.failure(outcome);
    const record = ompBtwResponseSchema.parse(outcome.data).record;
    const provisionalId = btwViewId(view.parent, record.id);
    const provisional =
      this.views.get(provisionalId) ?? this.makeView(provisionalId, view.parent, record.id, config);
    provisional.sources.set(record.followUps?.length ?? 0, envelope.commandId);
    // 同一 stdout 分片可在 response 的 Promise continuation 前已有 delta/terminal；
    // 事件投影是更晚事实，不能用准入 response 的 running record 覆盖。
    this.project(
      provisional,
      this.parents.get(view.parent)!.serial === serial || !provisional.record
        ? record
        : provisional.record,
      config,
    );
    if (!view.recordId) {
      view.recordId = record.id;
      view.sources.set(record.followUps?.length ?? 0, envelope.commandId);
      this.project(view, provisional.record!, config);
    }
    // 首次 BTW 会确保父文件落盘；用真实 UUID 形成可跨进程恢复的地址。
    await process.refreshState();
    if (host.currentProcess() !== process)
      throw new ProtocolError(-32000, "side session process changed; recover history");
    const stableParent = ompSessionIdOfFilePath(process.ompSessionFile);
    if (!stableParent)
      throw new ProtocolError(
        -32000,
        "BTW accepted but parent identity unavailable; recover saved history",
      );
    const canonical = btwViewId(stableParent, record.id);
    const target =
      this.views.get(canonical) ?? this.makeView(canonical, stableParent, record.id, config);
    if (target !== provisional) {
      for (const [index, source] of provisional.sources) target.sources.set(index, source);
      this.project(target, provisional.record!, config);
      await this.parent(stableParent);
    }
    return {
      type: "createSelectionSideSession",
      sessionId: canonical,
      parentSessionId: stableParent,
      input: { delivery: "startNow", inputId: createId("input") },
    };
  }

  async stop(id: string): Promise<boolean> {
    const view = this.views.get(id) ?? (await this.acquire(id));
    if (!view.recordId) return false;
    const engine = await this.parent(view.parent);
    const host = engine.subagentProcessHost();
    const process = host.currentProcess()!;
    const outcome = await process.send({ type: "btw_cancel", recordId: view.recordId });
    if (host.currentProcess() !== process)
      throw new ProtocolError(-32000, "side session process changed during cancellation");
    if (!outcome.success) this.failure(outcome);
    return ompBtwCancelSchema.parse(outcome.data).cancelled;
  }
  setConnectionFlowState(connectionId: string, state: "saturated" | "drained" | "closed"): void {
    for (const view of this.views.values())
      view.publisher.setConnectionFlowState(connectionId, state);
  }
  dispose(): void {
    for (const owner of this.parents.values()) owner.off();
    for (const view of this.views.values()) view.publisher.dispose();
    this.parents.clear();
    this.views.clear();
  }
}
