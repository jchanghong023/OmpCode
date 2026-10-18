// 引擎 prompt 轮收口组（自 promptTurnCloser.ts 拆出，架构 maxFileLines=400）：宿主接口与共享
// 运行态（代次/停止租约/延迟计数）+ 收口路径——本地命令完成（agentInvoked=false）、
// prompt_result 终态（A1）、轮失败、停止与重置。分发组（sendText 排队与派发屏障）见
// promptTurnCloser.ts 的 EnginePromptTurnCloser（继承本类并实现 pumpQueue 钩子）。
// 引擎状态经宿主回调读写，对外行为（flush 时机、终态判定）与拆出前逐语句一致。

import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import { agentInvokedOf } from "../domain/titleText.js";
import type { OmpSessionProcess } from "./ports.js";
import type { SlashCommandResolver } from "./ompPromptDispatch.js";
import { diagnostics } from "./diagnostics.js";
import { logTurnTransitions, turnContext } from "./turnDiagnostics.js";

/** 引擎侧宿主：收口/分发流程对引擎状态的读写出口（全部惰性求值，避免构造顺序耦合）。 */
export interface EnginePromptTurnHost {
  projection: () => ConversationProjection;
  isStreaming: () => boolean;
  followupMode: () => SessionConfigState["followupMode"];
  /** 首条输入推导标题（仅一次；title 初始化状态由引擎持有）。 */
  ensureTitleFromText: (text: string) => void;
  ensureStarted: () => Promise<void>;
  currentProcess: () => OmpSessionProcess | null;
  flush: () => void;
  /** 斜杠命令目录解析器（工作区目录进程 v3 富目录）；缺省不做严格分发。 */
  resolveSlashCommand?: SlashCommandResolver;
}

/** 收口组基类：独占共享运行态，分发组经 pumpQueue 钩子推进排队派发。 */
export abstract class PromptTurnClosing {
  /** 流式中到达的本地命令完成：延迟到 terminal agent_end 统一收口（onTerminalAgentEnd）。 */
  private pendingLocalOnlyCompletions = 0;
  /** 代次/停止租约由收口路径写、分发组读（派发屏障内复核同一代）。 */
  protected generation = 0;
  protected stopping = false;
  private stopEpoch = 0;

  constructor(protected readonly host: EnginePromptTurnHost) {}

  /** 分发组实现：推进队列派发（afterStop=true 时允许从 completedInterrupted 恢复）。 */
  protected abstract pumpQueue(afterStop?: boolean): void;

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
    id?: string;
    status?: string;
    error?: string | { message?: string };
  }): void {
    const submission = frame.id ? this.host.projection().submissionForCommand(frame.id) : null;
    if (
      !submission ||
      submission.generation !== this.generation ||
      submission.state === "pending" ||
      submission.state === "cancelled"
    ) {
      diagnostics.debug("omp.turn.prompt_result.ignored", {
        commandId: frame.id,
        reason: "no_matching_submission",
      });
      return;
    }
    if (frame.agentInvoked === false && frame.status !== "error" && frame.status !== "aborted") {
      submission.state = "consumed";
      this.finishLocalOnly(frame.id);
      this.pumpQueue();
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
      this.pendingLocalOnlyCompletions -= 1;
      this.finishLocalOnly();
    }
    const control = this.host.projection().stateSnapshot.control;
    if (control.phase === "error") {
      this.cancelPending("failed", this.host.projection().lastError ?? undefined);
    } else if (control.phase === "completedInterrupted" && !this.stopping) {
      this.cancelPending("interrupted");
    } else if (control.phase === "completedSuccess") {
      this.pumpQueue();
    }
  }

  /** 进程退出：在途完成不再有意义（引擎 failAllTurns 已收口全部轮）。 */
  reset(error?: { code: string; message: string }): void {
    this.cancelPending("failed", error);
    this.pendingLocalOnlyCompletions = 0;
    this.stopping = false;
  }

  /** 同步撤销旧租约；随后 native stop 的异步响应不能取消新输入。 */
  beginStop(): () => void {
    const epoch = ++this.stopEpoch;
    this.stopping = true;
    this.cancelPending("interrupted");
    return () => {
      if (this.stopEpoch !== epoch) return;
      this.stopping = false;
      this.pumpQueue(true);
    };
  }

  private cancelPending(
    outcome: "interrupted" | "failed",
    error?: { code: string; message: string },
  ): void {
    this.generation += 1;
    const projection = this.host.projection();
    projection.cancelQueuedSubmissions(outcome, error);
    if (!this.host.isStreaming()) projection.finishTurn(outcome, error);
    this.host.flush();
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
    if (projection.stateSnapshot.control.phase === "error")
      this.cancelPending("failed", { code, message });
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
    if (sourceCommandId && projection.activeTurnSourceCommandId() !== sourceCommandId) return;
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
  private finishTerminal(frame: {
    id?: string;
    status?: string;
    error?: string | { message?: string };
  }): void {
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
    if (failure && frame.id) host.projection().failCommandTurn(frame.id, failure);
    else host.projection().finishTurn("interrupted");
    logTurnTransitions(host.projection(), beforeSeq, "prompt_result");
    this.cancelPending(failure ? "failed" : "interrupted", failure);
    host.flush();
  }
}
