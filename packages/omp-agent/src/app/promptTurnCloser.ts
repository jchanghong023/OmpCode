// 引擎 prompt 轮分发组（自 conversationEngine.ts 抽出，架构 maxFileLines=400）：
// sendText 的 omp dispatch 流程——排队/steer 在途标记、派发屏障与失败收口；收口组
// （本地命令完成 agentInvoked=false、prompt_result 终态 A1、轮失败）与共享运行态
// （代次/停止租约）见 promptTurnClosing.ts 的 PromptTurnClosing 基类。
// 引擎状态经宿主回调读写，对外行为（delivery 返回值、flush 时机、终态判定）与抽出前逐语句一致。

import type { TurnSubmission } from "../domain/projectionRows.js";
import { createId } from "../domain/ids.js";
import { agentInvokedOf } from "../domain/titleText.js";
import { dispatchOmpText } from "./ompPromptDispatch.js";
import { diagnostics } from "./diagnostics.js";
import { PromptTurnClosing } from "./promptTurnClosing.js";

export type QueueItemActionResult =
  | "accepted"
  | "noop"
  | "inFlight"
  | "unsupportedInput"
  | "stopping";

export class EnginePromptTurnCloser extends PromptTurnClosing {
  private dispatchTail: Promise<void> = Promise.resolve();

  /** 恢复只武装同一 owner；闲态领取也必须排在既有派发屏障之后。 */
  setAutoDrain(autoDrain: boolean): void {
    const projection = this.host.projection();
    projection.setAutoDrain(autoDrain);
    diagnostics.info("omp.queue.auto_drain.changed", {
      sessionId: projection.sessionId,
      autoDrain,
      pauseReason: projection.stateSnapshot.queue.pauseReason,
      phase: projection.stateSnapshot.control.phase,
      waitingCount: projection.stateSnapshot.queue.items.length,
    });
    this.host.flush();
    if (autoDrain) this.pumpQueue(true);
  }

  queueItemAction(action: "delete" | "interject", queueItemId: string): QueueItemActionResult {
    const projection = this.host.projection();
    const submission = projection.submissionForCommand(queueItemId);
    const rejected = this.stopping
      ? "stopping"
      : !submission
        ? "noop"
        : submission.state !== "pending" || submission.generation !== this.generation
          ? "inFlight"
          : action === "interject" && submission.originalText.trimStart().startsWith("/")
            ? "unsupportedInput"
            : null;
    if (rejected || !submission) {
      diagnostics.debug("omp.queue.item.ignored", {
        sessionId: projection.sessionId,
        queueItemId,
        action,
        reason: rejected,
      });
      return rejected ?? "noop";
    }
    // 应用项尚未进入 native 队列：原 payload 只领取一次，不调用 native promote 或停止当前轮。
    const delivery =
      this.host.isStreaming() || projection.stateSnapshot.control.phase === "running"
        ? "steer"
        : "prompt";
    projection.actOnPendingQueueItem(queueItemId, action === "delete" ? "delete" : delivery);
    this.host.flush();
    diagnostics.info("omp.queue.item.changed", {
      sessionId: projection.sessionId,
      queueItemId,
      action,
      delivery,
      waitingCount: projection.stateSnapshot.queue.items.length,
    });
    if (action === "interject") void this.enqueueDispatch(submission);
    return "accepted";
  }

  /** queue 的 accepted payload 只写入既有 TurnContext；成功终态之前不向核心投递。 */
  async sendText(
    text: string,
    sourceCommandId: string,
    clientId: string,
    images: { type: "image"; data: string; mimeType: string }[] = [],
    modelSelection?: { provider: string; model: string; thought?: string },
    originalText = text,
  ): Promise<"startNow" | "queue"> {
    const host = this.host;
    const projection = host.projection();
    const inputId = createId("input");
    const busy =
      this.stopping ||
      host.isStreaming() ||
      projection.stateSnapshot.control.phase === "running" ||
      projection.hasQueuedTurns();
    const guide =
      busy &&
      !this.stopping &&
      !originalText.trimStart().startsWith("/") &&
      host.followupMode() === "guide";
    const config = projection.stateSnapshot.config;
    // 排队时未显式改模型也要冻结已知配置；首会话尚未水合时仍由真实核心提供默认模型。
    const selection =
      modelSelection ??
      (busy && config.provider && config.model
        ? { provider: config.provider, model: config.model, thought: config.thought }
        : undefined);
    const submission: TurnSubmission = {
      text,
      originalText,
      images,
      modelSelection: selection,
      sourceCommandId,
      clientId,
      generation: this.generation,
      delivery: guide ? "steer" : "prompt",
      state: busy && !guide ? "pending" : "dispatching",
    };
    return diagnostics.run(
      { sessionId: projection.sessionId, commandId: sourceCommandId, inputId },
      async () => {
        host.ensureTitleFromText(text);
        projection.beginUserTurn({
          text,
          inputId,
          sourceCommandId,
          clientId,
          submission,
          routing: busy ? (guide ? "guide" : "queue") : "startNow",
        });
        host.flush();
        diagnostics.info("omp.input.accepted", {
          sessionId: projection.sessionId,
          commandId: sourceCommandId,
          inputId,
          routing: busy ? (guide ? "guide" : "queue") : "startNow",
          dispatchType: submission.state === "pending" ? "owner_queue" : submission.delivery,
          textLength: text.length,
          originalTextLength: originalText.length,
          imageCount: images.length,
          modelSelectionPresent: Boolean(modelSelection),
        });
        if (submission.state !== "pending") await this.enqueueDispatch(submission);
        return busy ? "queue" : "startNow";
      },
    );
  }

  protected pumpQueue(afterStop = false): void {
    void this.enqueueDispatch(undefined, afterStop);
  }

  private enqueueDispatch(submission?: TurnSubmission, afterStop = false): Promise<void> {
    const generation = this.generation;
    const work = this.dispatchTail.then(async () => {
      if (!submission) {
        const projection = this.host.projection();
        const phase = projection.stateSnapshot.control.phase;
        // 领取与派发在同一屏障内复核策略/代次；忙中恢复、重复终态都不能抢跑队首。
        if (
          generation !== this.generation ||
          this.stopping ||
          this.host.isStreaming() ||
          !projection.stateSnapshot.queue.autoDrain ||
          (phase !== "completedSuccess" && !(afterStop && phase === "completedInterrupted"))
        )
          return;
        submission = projection.claimQueuedSubmission(generation) ?? undefined;
        if (!submission) return;
        this.host.flush();
      }
      await this.dispatchSubmission(submission);
    });
    this.dispatchTail = work.catch((error: unknown) => {
      if (
        submission &&
        submission.generation === this.generation &&
        submission.state !== "cancelled"
      ) {
        this.failTurn(submission.sourceCommandId, "omp_prompt_failed", error);
      }
    });
    return this.dispatchTail;
  }

  private async dispatchSubmission(submission: TurnSubmission): Promise<void> {
    const host = this.host;
    const current = () =>
      submission.generation === this.generation &&
      submission.state !== "cancelled" &&
      !this.stopping;
    if (!current()) return;
    const context = {
      sessionId: host.projection().sessionId,
      commandId: submission.sourceCommandId,
    };
    await diagnostics.run(context, async () => {
      const startedAt = Date.now();
      try {
        await host.ensureStarted();
        if (!current()) return;
        const process = host.currentProcess();
        if (!process) throw new Error("omp core failed to start");
        const isCurrent = () => current() && host.currentProcess() === process;
        diagnostics.info("omp.input.dispatch.started", context);
        const outcome = await dispatchOmpText({
          process,
          text: submission.text,
          originalText: submission.originalText,
          sourceCommandId: submission.sourceCommandId,
          images: submission.images,
          modelSelection: submission.modelSelection,
          streaming: submission.delivery === "steer",
          currentConfig: host.projection().stateSnapshot.config,
          isCurrent,
          ...(host.resolveSlashCommand ? { resolveSlashCommand: host.resolveSlashCommand } : {}),
        });
        if (!isCurrent()) {
          diagnostics.debug("omp.input.dispatch.stale_ack", {
            ...context,
            failureStage: "submission_fence",
          });
          return;
        }
        if (!outcome.success) {
          this.failTurn(
            submission.sourceCommandId,
            outcome.code ?? "omp_prompt_failed",
            new Error(outcome.error ?? "prompt rejected"),
          );
          return;
        }
        if (submission.state === "dispatching") submission.state = "accepted";
        diagnostics.info("omp.input.dispatch.ack", {
          ...context,
          elapsedMs: Date.now() - startedAt,
          success: true,
          agentInvoked: agentInvokedOf(outcome.data),
        });
        if (agentInvokedOf(outcome.data) === false) submission.state = "consumed";
        this.noteDispatchOutcome(outcome.data, submission.sourceCommandId);
      } catch (error) {
        if (current()) {
          diagnostics.error("omp.input.dispatch.failed", {
            ...context,
            elapsedMs: Date.now() - startedAt,
            failureStage: "dispatch_exception",
            errorType: error instanceof Error ? error.name : typeof error,
          });
          this.failTurn(submission.sourceCommandId, "omp_prompt_failed", error);
        }
      } finally {
        this.pumpQueue();
      }
    });
  }
}
