// 队列对账与 steer 在途状态的引擎侧协调器（A3/A5，自 conversationEngine.ts 内聚抽出）。
// 纯逻辑 + 依赖注入回调：不持有进程对象（经 currentProcess() 读引擎当前进程），投影
// 事实经引用/回调读出，状态应用与 flush 由引擎回调完成；引擎持有实例调用。

import type { OmpSessionEventFrame, OmpStateData } from "../domain/ompFrames.js";
import { ompQueueTextsOf } from "../domain/ompProjector.js";
import { markQueueReconcileTexts, type QueueReconcileMode } from "../domain/queuedTurnReconcile.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpSessionProcess } from "./ports.js";
import { refreshEngineStateAfterActivity } from "./ompEngineProcess.js";

/** A3：queue_update 触发对账的 debounce 窗口（短窗口合并多次触发）。 */
const QUEUE_RECONCILE_DEBOUNCE_MS = 250;
/**
 * S4-2 宽限复查延迟：覆盖 omp #queueUserMessage 对图片附件的秒级视觉描述延迟
 * （agent-session.ts:8053-8170，描述生成完成才真正入队）与新核输入门串行入队；
 * 超过该窗口仍未在任何快照中在场才判 interrupted。
 */
const QUEUE_GRACE_RECHECK_DELAY_MS = 2000;

export interface PromptQueueReconcilerDeps {
  /** 投影（排队轮事实与收口出口：hasQueuedTurns/reconcileQueuedTurns/活跃轮判定）。 */
  readonly projection: ConversationProjection;
  /** 引擎当前 omp 进程（null=未启动；发起 get_state 前读取）。 */
  readonly currentProcess: () => OmpSessionProcess | null;
  /** 回包时进程是否仍是引擎当前进程（防旧进程回包污染新进程状态）。 */
  readonly isCurrentProcess: (process: OmpSessionProcess) => boolean;
  /** 回读快照的通用应用（模型配置/上下文窗口/标题；与队列对账无关，不受陈旧守卫影响）。 */
  readonly applyState: (state: OmpStateData | null) => void;
  /** omp 是否流式中（流式中只登记 seen，不判定队列对账收口）。 */
  readonly isStreaming: () => boolean;
  /** 对账发生收口时通知引擎 flush。 */
  readonly scheduleFlush: () => void;
}

export class PromptQueueReconciler {
  /** A5：在途 steer 的 guide 轮 sourceCommandId（steer 响应返回/失败时清除）。 */
  private steerGuideCommandId: string | null = null;
  /** A3：queue_update 触发的对账 debounce 定时器（短窗口合并多次触发）。 */
  private queueReconcileTimer: NodeJS.Timeout | null = null;
  /**
   * S4-2：宽限复查一次性定时器。terminal agent_end 对账后仍排队且从未在任何 omp 队列
   * 快照中在场的轮，可能仍在入队路上（图片附件秒级描述延迟 / 新核输入门串行），立即
   * 缺席判定会误关——保持排队并宽限一次复查：复查快照仍缺席且期间未被 queue_update
   * 携带（登记 seen）→ interrupted 收口；复查前出现过再消失 → 按合并终态收口。
   */
  private graceRecheckTimer: NodeJS.Timeout | null = null;
  /**
   * queue_update 对账触发的调度序号（get_state 去重用）：每次 scheduleQueueReconciliation
   * 递增；refreshAfterActivity 回读完成后若序号未变，挂起的 debounce 定时器只会重复
   * 拉取同一份更陈旧的快照，直接清掉。
   */
  private queueReconcileScheduleSeq = 0;
  /** dispose 后不再安排新的宽限复查（在途回读的收尾可能晚于 dispose）。 */
  private disposed = false;
  /**
   * 输入接受序号（XR1 陈旧快照竞态守卫）：引擎每接受一条用户输入（本地入列）+1；
   * 发起对账 get_state 时捕获当前序号，回包时序号已变说明在途期间接受了新输入，
   * 该快照可能不含新消息文本，本轮对账必须跳过（见 refreshAfterActivity）。
   */
  private inputAcceptedSeq = 0;
  /** 成功 abort 的输入代次；只取消该边界之前从未见到队列事实的等待轮。 */
  private abortedInputSeq: number | null = null;

  constructor(private readonly deps: PromptQueueReconcilerDeps) {}

  /** A5 投影器钩子实现：在途 steer 的 guide 轮（与当前活跃轮一致）才返回其 sourceCommandId。 */
  steerGuideCommandIdOf(): string | null {
    const id = this.steerGuideCommandId;
    return id !== null && this.deps.projection.activeTurnSourceCommandId() === id ? id : null;
  }

  /** A5 在途标记：steer 分支 beginUserTurn(guide) 前置位（两步间无 yield 点），响应返回后清除。 */
  markSteerInFlight(sourceCommandId: string): void {
    this.steerGuideCommandId = sourceCommandId;
  }

  /** A5 在途标记清除：steer 响应已返回（成功或失败；失败路径由引擎 failTurn 收口）。 */
  clearSteerInFlight(): void {
    this.steerGuideCommandId = null;
  }

  /**
   * F010：登记真实 queue_update 的完整快照，不把 RPC success 当接纳证据。
   * 到达时立即 markOnly，保留 debounce 前 enqueue → drain 的快速消费事实；
   * 收口仍统一由非流式 get_state 对账决定。
   */
  noteQueueSnapshot(event: Extract<OmpSessionEventFrame, { type: "queue_update" }>): void {
    const texts = ompQueueTextsOf({ queuedMessages: event });
    if (texts !== null) {
      this.deps.projection.reconcileQueuedTurns(markQueueReconcileTexts(texts, "markOnly"));
    }
  }

  /**
   * abort 的成功响应才证明输入门取消边界生效。捕获发送前的输入代次，避免响应
   * 在途期间的新输入被旧 abort 取消；后续终态回读继续沿用该边界，不新增超时。
   */
  prepareAbortReconciliation(): () => Promise<void> {
    const seqAtAbort = this.inputAcceptedSeq;
    return async () => {
      if (this.disposed || this.inputAcceptedSeq !== seqAtAbort) return;
      this.abortedInputSeq = seqAtAbort;
      await this.refreshAfterActivity();
    };
  }

  /** A3 触发点（queue_update 事件）：debounce 合并短窗口内的多次触发后回读 get_state。 */
  scheduleQueueReconciliation(): void {
    this.queueReconcileScheduleSeq += 1;
    if (this.queueReconcileTimer) return;
    this.queueReconcileTimer = setTimeout(() => {
      this.queueReconcileTimer = null;
      void this.refreshAfterActivity();
    }, QUEUE_RECONCILE_DEBOUNCE_MS);
    this.queueReconcileTimer.unref?.();
  }

  /**
   * XR1 守卫递增点：引擎在 sendText 接受输入（本地入列）时调用。提前到接受点而非
   * dispatch 成功点：dispatch 在途窗口内 terminal agent_end 也可能先被处理（同源
   * 竞态），整窗覆盖；dispatch 失败路径已由 failTurn 收口，被跳过的对账由后续
   * queue_update/agent_end 触发点重新发起，不会丢失。
   */
  noteInputAccepted(): void {
    // 核心崩溃后同一引擎可重启；新输入重新武装宽限对账，不能沿用退出时的 disposed。
    this.disposed = false;
    this.inputAcceptedSeq += 1;
  }

  /**
   * 活动后状态回读 + 队列对账（A3）：terminal agent_end / debounce / compact 复用同一次
   * get_state。陈旧快照守卫（XR1）：对账 get_state 在途期间用户提交新排队消息（本地已入
   * queuedTurns，omp 尚未处理其 follow_up），且 terminal agent_end 恰在陈旧回包前处理（使
   * 流式守卫失效）时，陈旧快照不含新消息文本，会把新排队轮误收口 interrupted 并静默丢弃
   * 其后续输出——序号已变时跳过本轮对账（applyState 照常，其内容与输入无关），交给下一
   * 次 queue_update/agent_end 重新触发。
   * @param options.queueReconcileMode 本次对账模式（S4-2 宽限复查传 "forceClose"）。
   * @param options.graceRecheckAfter terminal agent_end 专用：默认对账完成后仍排队时安排
   *   一次宽限复查（forceClose），不误关仍在入队路上的从未 seen 轮。
   */
  async refreshAfterActivity(
    options: { queueReconcileMode?: QueueReconcileMode; graceRecheckAfter?: boolean } = {},
  ): Promise<void> {
    const seqAtRequest = this.inputAcceptedSeq;
    const scheduleSeqAtRequest = this.queueReconcileScheduleSeq;
    await refreshEngineStateAfterActivity(
      this.deps.currentProcess(),
      this.deps.isCurrentProcess,
      (state) => {
        this.deps.applyState(state);
        if (seqAtRequest !== this.inputAcceptedSeq) return;
        const mode =
          options.queueReconcileMode ??
          (this.abortedInputSeq === seqAtRequest ? "forceClose" : null);
        this.reconcileQueuedTurnsWith(state, mode);
      },
    );
    // get_state 去重：本次回读完成后，若在途期间没有新的 queue_update 触发（调度序号
    // 未变），挂起的 debounce 定时器只会重复拉取同一份比本次更陈旧的快照，直接清掉，
    // 消除背靠背重复 IPC；序号已变说明有新触发在排队，保留由其合并后续触发（对账
    // 幂等，被跳过的对账由后续 queue_update/agent_end 重新发起，不会丢失）。
    if (scheduleSeqAtRequest === this.queueReconcileScheduleSeq && this.queueReconcileTimer) {
      clearTimeout(this.queueReconcileTimer);
      this.queueReconcileTimer = null;
    }
    // S4-2：terminal agent_end 的默认对账完成后仍有排队轮——其中可能存在从未 seen、
    // 仍在入队路上的轮，安排一次宽限复查。序号已变（在途期间接受新输入）时不安排：
    // 陈旧快照不该参与判定，新输入有自己的触发链（queue_update / 下一个 agent_end）。
    if (
      options.graceRecheckAfter &&
      !this.disposed &&
      seqAtRequest === this.inputAcceptedSeq &&
      this.deps.projection.hasQueuedTurns()
    ) {
      this.scheduleGraceRecheck();
    }
  }

  /**
   * 用 get_state 快照对账本地排队轮。流式中只登记 seen（S4-1 在场历史：omp 停止边界会把
   * 排队 follow_up 合并进同一 run 消费（A4），此刻快照在场与否都要留痕，供 agent_end
   * 对账区分「drain 消费」与「从未入队」），不判定收口（既有不变式：流式中不判定）。
   * 空闲收口判定：seen 且缺席按合并终态；从未 seen 保持排队（S4-2 宽限），仅宽限复查
   * （forceClose）仍缺席才按 interrupted 收口。快照缺失/形状不明时不动（不确定→不动，
   * 绝不误关）。
   */
  private reconcileQueuedTurnsWith(
    state: OmpStateData | null,
    mode: QueueReconcileMode | null,
  ): void {
    if (!state) return;
    const texts = ompQueueTextsOf(state);
    if (texts === null) return;
    if (this.deps.isStreaming()) {
      this.deps.projection.reconcileQueuedTurns(markQueueReconcileTexts(texts, "markOnly"));
      return;
    }
    const payload = mode === "forceClose" ? markQueueReconcileTexts(texts, "forceClose") : texts;
    if (this.deps.projection.reconcileQueuedTurns(payload) > 0) this.deps.scheduleFlush();
  }

  /** S4-2 宽限复查：一次性定时器（已挂起不重复）；复查走 forceClose 模式对账。 */
  private scheduleGraceRecheck(): void {
    if (this.graceRecheckTimer || this.disposed) return;
    this.graceRecheckTimer = setTimeout(() => {
      this.graceRecheckTimer = null;
      // 期间全部收口（合并/失败等）则无需复查；新 run 流式中亦只登记不收口（见对账判定）。
      if (!this.deps.projection.hasQueuedTurns()) return;
      void this.refreshAfterActivity({ queueReconcileMode: "forceClose" });
    }, QUEUE_GRACE_RECHECK_DELAY_MS);
    this.graceRecheckTimer.unref?.();
  }

  /** 进程退出/引擎销毁：挂起的对账与在途 steer 标记不再有意义（轮次已另行收口），清理。 */
  dispose(): void {
    this.disposed = true;
    this.abortedInputSeq = null;
    this.steerGuideCommandId = null;
    if (this.queueReconcileTimer) {
      clearTimeout(this.queueReconcileTimer);
      this.queueReconcileTimer = null;
    }
    if (this.graceRecheckTimer) {
      clearTimeout(this.graceRecheckTimer);
      this.graceRecheckTimer = null;
    }
  }
}
