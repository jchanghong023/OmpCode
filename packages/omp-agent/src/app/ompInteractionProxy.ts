// omp 工具与扩展 UI 请求 → ZCode pendingInteraction + 宿主反向请求的代理。
// 两类请求共用一条汇入路径：宿主直接应答 interaction/requestUserInput，
// 或 UI 经 v4 resolveInteraction 命令回执；两者汇合到同一个 deferred，先到先用；
// 本地宽裕预算兜底取消（见 INTERACTION_WAIT_BUDGET_MS 注释，主收口是 dispose/close/cancel 帧）。
//
// 富 ask（set_ask_dialog 启用后）以 extension_ui_request{method:"ask"} 携带完整问题集
// （多题/多选/选项说明/preview），投影为 ElicitationDialog 富问答；应答按题回传
// extension_ui_response{answers}。服务端超时按 recommended 自动收尾，本地只投影倒计时。

import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { createInteractionId } from "../domain/ids.js";
import type {
  HostGateway,
  HostUserInputAnswer,
  HostUserInputQuestion,
  OmpAskRequest,
  OmpUiRequest,
} from "./ports.js";
import { askDeadlineOf, askResponseOf } from "./ompInteractionMapping.js";
import { toOmpUiResponse } from "./ompUiResponseOf.js";
import { interactionDiagnostics } from "./ompInteractionDiagnostics.js";
import { diagnostics } from "./diagnostics.js";

interface InteractionDeps {
  sessionId: string;
  gateway: HostGateway;
  addPendingInteraction: (interaction: PendingInteraction) => void;
  resolvePendingInteraction: (interactionId: string) => void;
  scheduleFlush: () => void;
}

interface WaitingInteraction {
  ompRequestId: string;
  kind: "ui" | "ask";
  stage: string;
  resolve: (answer: HostUserInputAnswer) => void;
  timer: NodeJS.Timeout;
  reverseRequest: AbortController;
  /** ask：服务端到期自动收尾后的本地清场定时器。 */
  expireTimer?: NodeJS.Timeout;
}

// S5-3 依据：omp 侧交互等待多无超时（extension runner 的 select/ask 以 Promise.withResolvers
// 挂起，仅 abort/dispose 可解）、login secret 输入 timeout 600_000——本地兜底若用短预算
// （原 180s/170s），会在这些业务时序内把用户正在处理的审批/登录/表单自动取消。
// 该预算仅防交互条目泄漏；主收口路径是 dispose/close、omp cancel 帧（S5-2）、会话终态
// 与 ask 服务端到期收尾。
const INTERACTION_WAIT_BUDGET_MS = 30 * 60_000;

export class OmpInteractionProxy {
  private readonly interactions = new Map<string, WaitingInteraction>();

  constructor(private readonly deps: InteractionDeps) {}

  async handle(request: OmpUiRequest): Promise<void> {
    const method = request.frame.method;
    if (method === "cancel") {
      // S5-2 依据：omp abort/超时后由 requestRpcDialog 的 cancelHostDialog 与
      // requestRpcEditor 的 onAbort 发 {method:"cancel", targetId:<原请求id>}
      // （rpc-types.ts RpcExtensionUIRequest cancel 变体），通知宿主关闭 omp 已 settle 的对话框。
      // 按 targetId 反查等待中的交互并立即按取消收口，不再等本地预算兜底；
      // 回执 cancelled 帧对已 settle 的 omp 侧无害（其 pendingRequests 已删除）。
      const targetId = (request.frame as { targetId?: string }).targetId;
      if (!targetId)
        diagnostics.debug("omp.interaction.cancel.unmatched", {
          sessionId: this.deps.sessionId,
          ompRequestId: request.frame.id,
          reason: "target_missing",
        });
      if (targetId) this.cancelByOmpRequestId(targetId);
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      // omp 的状态类 UI 事件（notify/setStatus/setWidget/setTitle/set_editor_text）与
      // open_url 在适配层没有宿主呈现面，按取消回执，不让 omp 挂起。
      diagnostics.debug("omp.interaction.ui.unpresented", {
        sessionId: this.deps.sessionId,
        ompRequestId: request.frame.id,
        method,
        result: "cancelled",
      });
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    // S5-4 依据：omp requestRpcEditor 发 {method:"editor", title, prefill, promptStyle}
    // （rpc-session-host.ts），prefill 是编辑器初始文本；此前 schema 剥离导致宿主弹空框。
    // editor 即使没有初始正文也显式带空 prefill，让宿主保留多行编辑/取消语义，
    // 避免与普通 input 同形后误入单题问答和持久草稿入口。
    const prefill =
      method === "editor"
        ? "prefill" in request.frame && typeof request.frame.prefill === "string"
          ? request.frame.prefill
          : ""
        : undefined;
    const interactionId = createInteractionId();
    const startedAt = Date.now();
    const fields = interactionDiagnostics.started(
      this.deps.sessionId,
      interactionId,
      request.frame.id,
      method,
    );
    const prompt = request.frame.message ?? request.frame.prompt ?? request.frame.title ?? "";
    const options = request.frame.options?.map((option) => ({ optionId: option, label: option }));
    // 仅 select（工具审批/选项询问）投影为富问答卡。input/editor 是显式自由文本请求，
    // 必须走宿主既有 UserInputDialog：富问答的答案构建会 trim 自定义回答、空串还会被
    // falsy 判断当取消（ElicitationDialog.getQuestionAnswers / V4InteractionDialogs
    // 的 answerMode 分支），违反「input/editor 原样回传 value、空字符串是合法已提交值」
    // 的协议契约。实测 omp rpc-ui 的 input/editor 帧只发 {title,placeholder,prefill}。
    const useElicitation = method === "select";
    const pending: PendingInteraction = {
      interactionId,
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt,
        // rpc-ui 的 ask「自定义回答」用 editor；与 input 共用宿主自由文本入口。
        // 工具审批（extension runner select ["Approve","Deny"]）也走本回路，两档选项原样呈现。
        freeText: method === "input" || method === "editor",
        ...(options ? { options } : {}),
        // input/editor 的密码框标记（login secret 输入）：omp v3 曾下发，
        // 当前 rpc-ui 基线的 input/editor 帧只发 {title,placeholder,prefill}，
        // 故此处仅保留前向兼容投影，缺字段时退化为普通文本框。
        ...(request.frame.sensitive && (method === "input" || method === "editor")
          ? { sensitive: true }
          : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(useElicitation
          ? {
              answerMode: "option" as const,
              allowCustomInput: false,
              questions: [
                {
                  question: prompt,
                  header: request.frame.title ?? prompt,
                  options: (request.frame.options ?? []).map((option, index) => ({
                    value: option,
                    label: option,
                    ...(request.frame.optionDetails?.[index]?.description
                      ? { description: request.frame.optionDetails[index]!.description }
                      : {}),
                  })),
                },
              ],
            }
          : {}),
      },
    };
    this.deps.addPendingInteraction(pending);
    this.deps.scheduleFlush();
    interactionDiagnostics.presentedUi(fields, startedAt, options?.length ?? 0, useElicitation);
    const { answer, stage } = await this.awaitAnswer(
      interactionId,
      request.frame.id,
      "ui",
      (signal) =>
        this.deps.gateway
          .requestUserInput(
            {
              requestId: interactionId,
              sessionId: this.deps.sessionId,
              prompt,
              ...(options ? { options } : {}),
            },
            signal,
          )
          .then((hostAnswer) => this.settleFrom(interactionId, hostAnswer, "host_answer"))
          .catch((error: unknown) => {
            const settled = this.settleFrom(interactionId, { action: "cancel" }, "host_error");
            if (settled) fields.errorType = error instanceof Error ? error.name : typeof error;
            return settled;
          }),
    );
    const response = toOmpUiResponse(request, answer);
    interactionDiagnostics.uiResult(fields, startedAt, stage, answer, request, response);
    request.respond(response);
  }

  /** 富 ask：完整问题集一次下发，投影为 ElicitationDialog 富问答。 */
  async handleAsk(request: OmpAskRequest): Promise<void> {
    const frame = request.frame;
    const interactionId = createInteractionId();
    const startedAt = Date.now();
    const fields = interactionDiagnostics.started(
      this.deps.sessionId,
      interactionId,
      frame.id,
      "ask",
    );
    const questions: HostUserInputQuestion[] = frame.questions.map((question) => ({
      question: question.question,
      header: question.header?.trim() ? question.header : question.question,
      options: question.options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.preview ? { preview: option.preview } : {}),
      })),
      ...(question.multi ? { multiSelect: true } : {}),
      ...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
    }));
    const prompt = frame.questions[0]?.question || "ask";
    const deadlineAt = askDeadlineOf(frame);
    const createdAt = Date.now();
    const pending: PendingInteraction = {
      interactionId,
      kind: "userInput",
      anchorRowId: null,
      createdAt,
      // omp 服务端按 deadline 自动收尾（recommended）；这里只投影倒计时展示，
      // 到期由服务端收尾、适配器本地清场，不声明客户端自动作答。
      ...(deadlineAt && deadlineAt > createdAt
        ? {
            autoResolution: {
              state: "visibleCountdown" as const,
              startedAt: createdAt,
              visibleAt: createdAt,
              deadlineAt,
            },
          }
        : {}),
      payload: {
        kind: "userInput",
        prompt,
        freeText: true,
        // toolName=AskUserQuestion 是 UI 富问答窗（多题/多选/preview）的渲染键。
        toolName: "AskUserQuestion",
        questions,
        allowCustomInput: true,
      },
    };
    this.deps.addPendingInteraction(pending);
    this.deps.scheduleFlush();
    interactionDiagnostics.presentedAsk(fields, startedAt, questions);
    let expired = false;
    const { answer, stage } = await this.awaitAnswer(
      interactionId,
      frame.id,
      "ask",
      (signal) =>
        this.deps.gateway
          .requestUserInput(
            {
              requestId: interactionId,
              sessionId: this.deps.sessionId,
              prompt,
              questions,
            },
            signal,
          )
          .then((hostAnswer) => this.settleFrom(interactionId, hostAnswer, "host_answer"))
          .catch((error: unknown) => {
            const settled = this.settleFrom(interactionId, { action: "cancel" }, "host_error");
            if (settled) fields.errorType = error instanceof Error ? error.name : typeof error;
            return settled;
          }),
      {
        onExpire: () => {
          expired = true;
        },
        deadlineAt,
      },
    );
    if (expired) {
      interactionDiagnostics.askResult(fields, startedAt, stage, answer);
      // omp 已按 recommended 自动收尾该 ask：不再发帧，pending 交互已在到期时清场。
      return;
    }
    const response = askResponseOf(frame, answer);
    interactionDiagnostics.askResult(fields, startedAt, stage, answer, response);
    request.respond(response);
  }

  /**
   * 注册等待中的交互并挂本地宽裕预算兜底（INTERACTION_WAIT_BUDGET_MS）；ask 可选挂服务端到期清场定时器。
   * reverseRequest 负责发起宿主反向请求并把应答汇入 settle。
   */
  private awaitAnswer(
    interactionId: string,
    ompRequestId: string,
    kind: WaitingInteraction["kind"],
    reverseRequest: (signal: AbortSignal) => Promise<unknown>,
    ask?: { onExpire?: () => void; deadlineAt?: number },
  ): Promise<{ answer: HostUserInputAnswer; stage: string }> {
    let entry: WaitingInteraction;
    return new Promise<HostUserInputAnswer>((resolve) => {
      const timer = this.startWaitBudgetTimer(interactionId);
      entry = {
        ompRequestId,
        kind,
        resolve,
        stage: "ui_answer",
        timer,
        reverseRequest: new AbortController(),
      };
      if (ask?.deadlineAt && ask.deadlineAt > Date.now()) {
        const expireTimer = setTimeout(() => {
          // 核心已按 deadline 收尾；先标记，再经同一结算入口释放宿主等待。
          ask.onExpire?.();
          this.settleFrom(interactionId, { action: "cancel" }, "server_deadline");
        }, ask.deadlineAt - Date.now());
        expireTimer.unref?.();
        entry.expireTimer = expireTimer;
      }
      this.interactions.set(interactionId, entry);
      void reverseRequest(entry.reverseRequest.signal);
    }).then((answer) => {
      this.deps.resolvePendingInteraction(interactionId);
      this.deps.scheduleFlush();
      return { answer, stage: entry.stage };
    });
  }

  /** S5-3：本地等待预算定时器。 */
  private startWaitBudgetTimer(interactionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.settleFrom(interactionId, { action: "cancel" }, "local_budget");
    }, INTERACTION_WAIT_BUDGET_MS);
    timer.unref?.();
    return timer;
  }

  /** S5-2：按 omp 原请求 id 反查等待中的交互并按取消收口；未命中（已收口/非等待帧）为无害 no-op。 */
  private cancelByOmpRequestId(ompRequestId: string): boolean {
    for (const [interactionId, entry] of this.interactions) {
      if (entry.ompRequestId !== ompRequestId) continue;
      this.settleFrom(interactionId, { action: "cancel" }, "core_cancel");
      return true;
    }
    diagnostics.debug("omp.interaction.cancel.unmatched", {
      sessionId: this.deps.sessionId,
      ompRequestId,
      reason: "not_waiting",
    });
    return false;
  }

  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settle(interactionId: string, answer: HostUserInputAnswer): boolean {
    return this.settleFrom(interactionId, answer, "ui_answer");
  }

  private settleFrom(interactionId: string, answer: HostUserInputAnswer, stage: string): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry) {
      return false;
    }
    entry.stage = stage;
    this.interactions.delete(interactionId);
    clearTimeout(entry.timer);
    if (entry.expireTimer) clearTimeout(entry.expireTimer);
    // 根因：v4/核心取消原先只清代理等待，ProtocolServer 的反向请求仍持有 timer，
    // 正常退出时被误当未决断连。先摘除唯一结算项，再取消 transport lease，迟到回执无害。
    entry.reverseRequest.abort();
    entry.resolve(answer);
    return true;
  }

  /**
   * v4 snoozeInteractionAutoResolution 入口：ask 首次交互顺延本地倒计时。
   * omp v18.8.0 起富 ask 无服务端暂停帧（旧 ask_pause 已删），服务端倒计时继续；
   * 本地等待预算同步顺延一个完整周期，避免用户作答途中被兜底定时器取消。
   */
  snooze(interactionId: string): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry || entry.kind !== "ask") {
      return false;
    }
    if (entry.expireTimer) {
      clearTimeout(entry.expireTimer);
      entry.expireTimer = undefined;
    }
    clearTimeout(entry.timer);
    entry.timer = this.startWaitBudgetTimer(interactionId);
    return true;
  }

  /** 引擎销毁：全部交互按取消收口，避免 omp 侧等待悬挂。 */
  dispose(): void {
    const stage =
      diagnostics.context().interactionDisposalStage === "process_exit"
        ? "process_exit"
        : "session_close";
    for (const interactionId of this.interactions.keys()) {
      this.settleFrom(interactionId, { action: "cancel" }, stage);
    }
  }
}
