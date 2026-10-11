// 引擎 prompt 轮收口与用户输入分发（自 conversationEngine.ts 抽出，架构 maxFileLines=400）：
// 收口组——本地命令完成（agentInvoked=false）、prompt_result 终态（A1）、轮失败；分发组——
// sendText 的 omp dispatch 流程（排队/steer 在途标记、失败收口）。引擎状态经宿主回调读写，
// 对外行为（delivery 返回值、flush 时机、终态判定）与抽出前逐语句一致。

import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import { createId } from "../domain/ids.js";
import { agentInvokedOf } from "../domain/titleText.js";
import type { OmpSessionProcess } from "./ports.js";
import { dispatchOmpText, type SlashCommandResolver } from "./ompPromptDispatch.js";
import { diagnostics } from "./diagnostics.js";
import { logTurnTransitions, turnContext } from "./turnDiagnostics.js";

/** 引擎侧宿主：收口/分发流程对引擎状态的读写出口（全部惰性求值，避免构造顺序耦合）。 */
export interface EnginePromptTurnHost {
  projection: () => ConversationProjection;
  isStreaming: () => boolean;
  followupMode: () => SessionConfigState["followupMode"];
  /** 首条输入推导标题（仅一次；title 初始化状态由引擎持有）。 */
  ensureTitleFromText: (text: string) => void;
  markSteerInFlight: (sourceCommandId: string) => void;
  clearSteerInFlight: () => void;
  noteInputAccepted: () => void;
  ensureStarted: () => Promise<void>;
  currentProcess: () => OmpSessionProcess | null;
  flush: () => void;
  /** 斜杠命令目录解析器（工作区目录进程 v3 富目录）；缺省不做严格分发。 */
  resolveSlashCommand?: SlashCommandResolver;
}

export class EnginePromptTurnCloser {
  /** 流式中到达的本地命令完成：延迟到 terminal agent_end 统一收口（onTerminalAgentEnd）。 */
  private pendingLocalOnlyCompletions = 0;

  constructor(private readonly host: EnginePromptTurnHost) {}

  /** prompt 响应收口入口（onPromptResult 帧与 prompt 响应 data 的同一语义）：agentInvoked=false
   * 的完成帧走本地命令收口，其余走 prompt_result 终态判定（A1，agentInvoked=true 的完成帧
   * 紧随 agent_end，不能覆盖失败或中断终态；判定见 finishTerminal）。
   * 修复（S4-3）：agentInvoked=false 分支此前忽略 status——omp rpc-prompt-results.ts fail()
   * 语义是「prompt 在到达 agent 前失败」（status:"error" 且 agentInvoked=false），按需求 A1
   * 「失败→failed」必须走终态收口（透传 frame.error），不能当本地命令成功收口；仅
   * completed/无 status 的 agentInvoked=false 才是本地命令完成；未知 status 保持宽松处理
   * （消费侧只认已知值，与帧 schema 的宽松策略一致）。 */
  onPromptResult(frame: {
    agentInvoked?: boolean;
    status?: string;
    error?: string | { message?: string };
  }): void {
    if (frame.agentInvoked === false && frame.status !== "error" && frame.status !== "aborted") {
      this.finishLocalOnly();
    } else {
      this.finishTerminal(frame);
    }
  }

  /** prompt 响应 data.agentInvoked=false 的同步完成事实（dispatch 成功路径）。 */
  noteDispatchOutcome(data: unknown, sourceCommandId?: string): void {
    if (agentInvokedOf(data) === false) this.finishLocalOnly(sourceCommandId);
  }

  /** terminal agent_end：补收积压的本地命令完成（引擎在清流式判定后调用）。 */
  onTerminalAgentEnd(): void {
    while (this.pendingLocalOnlyCompletions > 0) {
      diagnostics.debug("omp.turn.local_completion.replayed", {
        ...turnContext(this.host.projection()),
        pendingCount: this.pendingLocalOnlyCompletions,
      });
      this.pendingLocalOnlyCompletions -= 1;
      this.finishLocalOnly();
    }
  }

  /** 进程退出：在途完成不再有意义（引擎 failAllTurns 已收口全部轮）。 */
  reset(): void {
    this.pendingLocalOnlyCompletions = 0;
  }

  /** 发送用户输入；返回实际 delivery（omp 流式中转为 follow_up 队列）。图片附件直接进 omp prompt。 */
  async sendText(
    text: string,
    sourceCommandId: string,
    clientId: string,
    images: { type: "image"; data: string; mimeType: string }[] = [],
    modelSelection?: { provider: string; model: string; thought?: string },
    originalText = text,
  ): Promise<"startNow" | "queue"> {
    const host = this.host;
    const inputId = createId("input");
    const context = { sessionId: host.projection().sessionId, commandId: sourceCommandId, inputId };
    return diagnostics.run(context, async () => {
      host.ensureTitleFromText(text);
      // 修复：首发已接受但 agent_start 尚未到达也属于 busy；后续输入不能再走 prompt。
      const streaming =
        host.isStreaming() || host.projection().stateSnapshot.control.phase === "running";
      const slashCommand = originalText.trimStart().startsWith("/");
      const guide = streaming && !slashCommand && host.followupMode() === "guide";
      // 修复（A5）：terminal agent_end 可能落在 beginUserTurn(guide) 与 steer 响应之间；
      // 在途标记让收口逻辑把无内容行的 guide 轮转回排队（由下一个 agent_start 激活），
      // 而不是被连带收口导致后续 drain 输出无轮承接。
      if (guide) host.markSteerInFlight(sourceCommandId);
      host.projection().beginUserTurn({
        text,
        inputId,
        sourceCommandId,
        clientId,
        routing: streaming ? (slashCommand ? "queue" : host.followupMode()) : "startNow",
      });
      // XR1 守卫：输入接受（本地入列）即递增对账序号，使在途的陈旧 get_state 回包跳过
      // 对账（新排队轮不被误收口）；接受点早于 dispatch 成功点，覆盖 dispatch 在途窗口。
      host.noteInputAccepted();
      host.flush();
      diagnostics.info("omp.input.accepted", {
        ...context,
        routing: streaming ? (slashCommand ? "queue" : host.followupMode()) : "startNow",
        dispatchType: streaming && !slashCommand ? (guide ? "steer" : "follow_up") : "prompt",
        textLength: text.length,
        originalTextLength: originalText.length,
        imageCount: images.length,
        modelSelectionPresent: Boolean(modelSelection),
      });
      try {
        try {
          await host.ensureStarted();
        } catch (error) {
          this.failTurn(sourceCommandId, "omp_start_failed", error);
          return streaming ? "queue" : "startNow";
        }
        const process = host.currentProcess();
        if (!process) {
          this.failTurn(sourceCommandId, "omp_unavailable", new Error("omp core failed to start"));
          return streaming ? "queue" : "startNow";
        }
        const startedAt = Date.now();
        diagnostics.info("omp.input.dispatch.started", context);
        try {
          const outcome = await dispatchOmpText({
            process,
            text,
            originalText,
            images,
            streaming,
            followupMode: host.followupMode(),
            modelSelection,
            currentConfig: host.projection().stateSnapshot.config,
            ...(host.resolveSlashCommand ? { resolveSlashCommand: host.resolveSlashCommand } : {}),
          });
          const dispatchFields = {
            ...context,
            elapsedMs: Date.now() - startedAt,
            success: outcome.success,
            code: outcome.code,
            agentInvoked: agentInvokedOf(outcome.data),
          };
          if (outcome.success) diagnostics.info("omp.input.dispatch.ack", dispatchFields);
          else
            diagnostics.error("omp.input.dispatch.failed", {
              ...dispatchFields,
              failureStage: outcome.code?.startsWith("omp_command_")
                ? "routing"
                : outcome.code?.startsWith("omp_set_")
                  ? "configuration"
                  : "core_rejection",
            });
          if (!outcome.success) {
            this.failTurn(
              sourceCommandId,
              outcome.code ?? "omp_prompt_failed",
              new Error(outcome.error ?? "prompt rejected"),
            );
            return streaming ? "queue" : "startNow";
          }
          // 重启/关闭后的旧 ACK 不得收口新进程的轮；输出本身也受进程实例 fence 保护。
          if (host.currentProcess() !== process) {
            diagnostics.warn("omp.input.dispatch.stale_ack", {
              ...context,
              failureStage: "process_fence",
            });
            return streaming ? "queue" : "startNow";
          }
          this.noteDispatchOutcome(outcome.data, sourceCommandId);
          if (slashCommand && agentInvokedOf(outcome.data) === false) return "startNow";
        } catch (error) {
          diagnostics.error("omp.input.dispatch.failed", {
            ...context,
            elapsedMs: Date.now() - startedAt,
            failureStage: "dispatch_exception",
            errorType: error instanceof Error ? error.name : typeof error,
          });
          // omp RPC 超时或进程退出会 reject，必须结束对应轮次。
          this.failTurn(sourceCommandId, "omp_prompt_failed", error);
        }
        return streaming ? "queue" : "startNow";
      } finally {
        // steer 响应已返回（成功或失败）：清除在途标记；失败路径 failTurn 已收口 guide 轮。
        if (guide) host.clearSteerInFlight();
      }
    });
  }

  failTurn(sourceCommandId: string, code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const projection = this.host.projection();
    const beforeSeq = projection.seq;
    diagnostics.error("omp.input.failed", {
      sessionId: projection.sessionId,
      commandId: sourceCommandId,
      code,
      failureStage:
        code === "omp_start_failed"
          ? "startup"
          : code === "omp_unavailable"
            ? "process_unavailable"
            : "dispatch",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    this.host.projection().failCommandTurn(sourceCommandId, { code, message });
    if (logTurnTransitions(projection, beforeSeq, code) === 0)
      diagnostics.debug("omp.turn.failure.ignored", {
        sessionId: projection.sessionId,
        commandId: sourceCommandId,
        reason: "no_matching_turn",
      });
    this.host.flush();
  }

  /** 本地命令收口（prompt 响应 data.agentInvoked=false 或异步 prompt_result）。 */
  private finishLocalOnly(sourceCommandId?: string): void {
    const host = this.host;
    const projection = host.projection();
    const beforeSeq = projection.seq;
    if (sourceCommandId && host.projection().finishQueuedLocalOnlyTurn(sourceCommandId)) {
      if (logTurnTransitions(projection, beforeSeq, "local_command_ack") === 0)
        diagnostics.debug("omp.turn.local_ack.ignored", {
          sessionId: projection.sessionId,
          commandId: sourceCommandId,
          reason: "no_matching_turn",
        });
      host.flush();
      return;
    }
    if (host.isStreaming()) {
      this.pendingLocalOnlyCompletions += 1;
      diagnostics.debug("omp.turn.local_completion.deferred", {
        ...turnContext(projection),
        commandId: sourceCommandId,
        pendingCount: this.pendingLocalOnlyCompletions,
      });
      return;
    }
    if (!projection.finishQueuedLocalOnlyTurn()) {
      projection.closeAssistantResponse();
      projection.finishTurn("success");
    }
    logTurnTransitions(projection, beforeSeq, "local_command_completion");
    host.flush();
  }

  /**
   * prompt_result 终态收口（A1）：status=aborted/error 且 agentInvoked=true 是「无模型
   * 回合」的取消/失败收尾（rpc-prompt-results.ts：abort 抢占 dispatch 或投递前失败），
   * 不会再来 agent 事件。仅当轮仍在 running 时收口（aborted→interrupted、error→failed）；
   * agent 仍在流式（agent_end 才是收口事实）或轮已被 agent_end 收口时必须 no-op，
   * 不得覆盖既有终态（agentInvoked=true 的 completed 帧紧随 agent_end 到达）。
   */
  private finishTerminal(frame: { status?: string; error?: string | { message?: string } }): void {
    const host = this.host;
    if (
      (frame.status !== "aborted" && frame.status !== "error") ||
      host.isStreaming() ||
      host.projection().stateSnapshot.control.phase !== "running"
    ) {
      diagnostics.debug("omp.turn.prompt_result.ignored", {
        ...turnContext(host.projection()),
        status: frame.status,
        streaming: host.isStreaming(),
        reason: "no_terminal_transition",
      });
      return;
    }
    const failure =
      frame.status === "error"
        ? {
            code: "omp_prompt_error",
            message:
              typeof frame.error === "string"
                ? frame.error
                : (frame.error?.message ?? "prompt failed"),
          }
        : undefined;
    const beforeSeq = host.projection().seq;
    host.projection().finishTurn(failure ? "failed" : "interrupted", failure);
    logTurnTransitions(host.projection(), beforeSeq, "prompt_result");
    host.flush();
  }
}
