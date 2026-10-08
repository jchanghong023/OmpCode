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
  resolve: (answer: HostUserInputAnswer) => void;
  timer: NodeJS.Timeout;
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
      if (targetId) this.cancelByOmpRequestId(targetId);
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      // omp 的状态类 UI 事件（notify/setStatus/setWidget/setTitle/set_editor_text）与
      // open_url 在适配层没有宿主呈现面，按取消回执，不让 omp 挂起。
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
    const prompt = request.frame.message ?? request.frame.prompt ?? request.frame.title ?? "";
    const options = request.frame.options?.map((option) => ({ optionId: option, label: option }));
    const useElicitation = method === "select" || method === "input" || method === "editor";
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
        // v3：input/editor 的密码框标记（login secret 输入解禁）。
        ...(request.frame.sensitive && (method === "input" || method === "editor")
          ? { sensitive: true }
          : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(useElicitation
          ? {
              answerMode: method === "select" ? ("option" as const) : ("text" as const),
              allowCustomInput: method !== "select",
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
    const answer = await this.awaitAnswer(interactionId, request.frame.id, "ui", () =>
      this.deps.gateway
        .requestUserInput({
          requestId: interactionId,
          sessionId: this.deps.sessionId,
          prompt,
          ...(options ? { options } : {}),
        })
        .then((hostAnswer) => this.settle(interactionId, hostAnswer))
        .catch(() => this.settle(interactionId, { action: "cancel" })),
    );
    request.respond(toOmpUiResponse(request, answer));
  }

  /** 富 ask：完整问题集一次下发，投影为 ElicitationDialog 富问答。 */
  async handleAsk(request: OmpAskRequest): Promise<void> {
    const frame = request.frame;
    const interactionId = createInteractionId();
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
    let expired = false;
    const answer = await this.awaitAnswer(
      interactionId,
      frame.id,
      "ask",
      () =>
        this.deps.gateway
          .requestUserInput({
            requestId: interactionId,
            sessionId: this.deps.sessionId,
            prompt,
            questions,
          })
          .then((hostAnswer) => this.settle(interactionId, hostAnswer))
          .catch(() => this.settle(interactionId, { action: "cancel" })),
      {
        onExpire: () => {
          expired = true;
        },
        deadlineAt,
      },
    );
    if (expired) {
      // omp 已按 recommended 自动收尾该 ask：不再发帧，pending 交互已在到期时清场。
      return;
    }
    request.respond(askResponseOf(frame, answer));
  }

  /**
   * 注册等待中的交互并挂本地宽裕预算兜底（INTERACTION_WAIT_BUDGET_MS）；ask 可选挂服务端到期清场定时器。
   * reverseRequest 负责发起宿主反向请求并把应答汇入 settle。
   */
  private awaitAnswer(
    interactionId: string,
    ompRequestId: string,
    kind: WaitingInteraction["kind"],
    reverseRequest: () => Promise<unknown>,
    ask?: { onExpire?: () => void; deadlineAt?: number },
  ): Promise<HostUserInputAnswer> {
    return new Promise<HostUserInputAnswer>((resolve) => {
      const timer = this.startWaitBudgetTimer(interactionId, resolve);
      const entry: WaitingInteraction = {
        ompRequestId,
        kind,
        resolve,
        timer,
      };
      if (ask?.deadlineAt && ask.deadlineAt > Date.now()) {
        const expireTimer = setTimeout(() => {
          // 服务端到期自动收尾：仅本地清场。
          this.interactions.delete(interactionId);
          clearTimeout(timer);
          this.deps.resolvePendingInteraction(interactionId);
          this.deps.scheduleFlush();
          ask.onExpire?.();
          resolve({ action: "cancel" });
        }, ask.deadlineAt - Date.now());
        expireTimer.unref?.();
        entry.expireTimer = expireTimer;
      }
      this.interactions.set(interactionId, entry);
      void reverseRequest();
    }).then((answer) => {
      this.deps.resolvePendingInteraction(interactionId);
      this.deps.scheduleFlush();
      return answer;
    });
  }

  /** S5-3：本地等待预算定时器。 */
  private startWaitBudgetTimer(
    interactionId: string,
    resolve: (answer: HostUserInputAnswer) => void,
  ): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.interactions.delete(interactionId);
      resolve({ action: "cancel" });
    }, INTERACTION_WAIT_BUDGET_MS);
    timer.unref?.();
    return timer;
  }

  /** S5-2：按 omp 原请求 id 反查等待中的交互并按取消收口；未命中（已收口/非等待帧）为无害 no-op。 */
  private cancelByOmpRequestId(ompRequestId: string): boolean {
    for (const [interactionId, entry] of this.interactions) {
      if (entry.ompRequestId !== ompRequestId) continue;
      this.settle(interactionId, { action: "cancel" });
      return true;
    }
    return false;
  }

  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settle(interactionId: string, answer: HostUserInputAnswer): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry) {
      return false;
    }
    this.interactions.delete(interactionId);
    clearTimeout(entry.timer);
    if (entry.expireTimer) clearTimeout(entry.expireTimer);
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
    entry.timer = this.startWaitBudgetTimer(interactionId, entry.resolve);
    return true;
  }

  /** 引擎销毁：全部交互按取消收口，避免 omp 侧等待悬挂。 */
  dispose(): void {
    for (const entry of this.interactions.values()) {
      clearTimeout(entry.timer);
      if (entry.expireTimer) clearTimeout(entry.expireTimer);
      entry.resolve({ action: "cancel" });
    }
    this.interactions.clear();
  }
}
