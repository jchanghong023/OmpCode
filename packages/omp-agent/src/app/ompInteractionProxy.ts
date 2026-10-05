// omp 工具与扩展 UI 请求 → ZCode pendingInteraction + 宿主反向请求的代理。
// 三类请求共用一条汇入路径：宿主直接应答 interaction/requestUserInput / interaction/requestPermission，
// 或 UI 经 v4 resolveInteraction 命令回执；两者汇合到同一个 deferred，先到先用；
// 本地宽裕预算兜底取消（见 INTERACTION_WAIT_BUDGET_MS 注释，主收口是 dispose/close/cancel 帧）。
//
// v3 fork surface（rpc-ui-protocol 4.1/4.3）：
// - permission_request → 权限审批卡（pendingInteraction kind permission，六档选项），应答回 permission_response；
// - ask_request → 富问答（完整问题集，ElicitationDialog 渲染），应答回 ask_response，倒计时暂停回 ask_pause。
// 未协商 v3 的 omp 二进制不会下发这两类帧，继续走 extension_ui_request 降级路径。

import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { createInteractionId } from "../domain/ids.js";
import type {
  HostGateway,
  HostUserInputAnswer,
  HostUserInputQuestion,
  OmpAskRequest,
  OmpPermissionRequest,
  OmpUiRequest,
} from "./ports.js";
import {
  askDeadlineOf,
  askResponseOf,
  ompOriginToZcode,
  permissionHostAnswerOf,
  permissionOptionsOf,
  permissionOptionsResponseOf,
  permissionResponseOf,
  permissionRiskLevelOf,
} from "./ompInteractionMapping.js";
import { toOmpUiResponse } from "./ompUiResponseOf.js";

interface InteractionDeps {
  sessionId: string;
  gateway: HostGateway;
  addPendingInteraction: (interaction: PendingInteraction) => void;
  resolvePendingInteraction: (interactionId: string) => void;
  scheduleFlush: () => void;
  /** 权限卡锚定到 omp 工具行（找不到时落 null，不影响呈现）。 */
  anchorRowIdOf?: (toolCallId: string) => number | null;
}

interface WaitingInteraction {
  ompRequestId: string;
  kind: "ui" | "permission" | "ask";
  resolve: (answer: HostUserInputAnswer) => void;
  timer: NodeJS.Timeout;
  /** ask：幂等暂停服务端倒计时（ask_pause）。 */
  pause?: () => void;
  /** ask：服务端到期自动收尾后的本地清场定时器；snooze 时取消。 */
  expireTimer?: NodeJS.Timeout;
}

// S5-3 依据：omp 侧权限门 await 无超时（rpc-session-host/rpc-fork-permission 用
// Promise.withResolvers，仅 abort/dispose 可解）、login secret 输入 timeout 600_000
// （rpc-session-host.ts inputSensitive/input）、ask 的 snooze（ask_pause）表示用户继续作答
// 且服务端倒计时已停——本地兜底若用短预算（原 180s/170s），会在这些业务时序内把用户
// 正在处理的审批/登录/表单自动取消，违反协议 §7.3「截止与暂停等已存在的业务语义归 OMP」。
// 该预算仅防交互条目泄漏；主收口路径是 dispose/close、omp cancel 帧（S5-2）、会话终态
// 与 ask 服务端到期收尾。
const INTERACTION_WAIT_BUDGET_MS = 30 * 60_000;

export class OmpInteractionProxy {
  private readonly interactions = new Map<string, WaitingInteraction>();

  constructor(private readonly deps: InteractionDeps) {}

  async handle(request: OmpUiRequest): Promise<void> {
    const method = request.frame.method;
    if (method === "cancel") {
      // S5-2 依据：omp abort/超时后由 requestRpcDialog 的 cancelHostDialog、requestRpcEditor
      // 与 rpc-fork-ask 的 onAbort 发 {method:"cancel", targetId:<原请求id>}
      // （rpc-types.ts RpcExtensionUIRequest cancel 变体），通知宿主关闭 omp 已 settle 的对话框。
      // 按 targetId 反查等待中的交互并立即按取消收口，不再等本地预算兜底；
      // 回执 cancelled 帧对已 settle 的 omp 侧无害（其 pendingRequests 已删除）。
      // ports.ts 的 frame 接口暂未声明 targetId（不在本次允许改动文件内），此处窄化读取。
      const targetId = (request.frame as { targetId?: string }).targetId;
      if (targetId) this.cancelByOmpRequestId(targetId);
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      // omp 的状态类 UI 事件与 open_url 在适配层没有宿主呈现面，按取消回执，不让 omp 挂起。
      request.respond({ type: "extension_ui_response", id: request.frame.id, cancelled: true });
      return;
    }
    // S5-4 依据：omp requestRpcEditor 发 {method:"editor", title, prefill, promptStyle}
    // （rpc-session-host.ts），prefill 是编辑器初始文本；此前 schema 剥离导致宿主弹空框。
    // shared userInput payload（packages/shared，不在本次允许改动范围）尚未声明该字段，
    // 以条件附加字段携带透传；宿主 UI 适配器（packages/ui pendingInteractionAdapter）
    // 当前只取 prompt/freeText/options 等显式字段，尚不消费 prefill。
    const prefill =
      method === "editor" ? (request.frame as { prefill?: string }).prefill : undefined;
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

  /** v3 结构化工具审批：权限审批卡 + interaction/requestPermission 反向请求。 */
  async handlePermission(request: OmpPermissionRequest): Promise<void> {
    const frame = request.frame;
    const interactionId = createInteractionId();
    const options = permissionOptionsOf(frame);
    const origin = ompOriginToZcode(frame.origin, this.deps.sessionId);
    // 审批门 reason 缺席时用 omp 预览行兜底，保证卡片始终有可读摘要。
    const summary =
      frame.reason?.trim() || frame.details[0] || `${frame.toolName} requests approval`;
    const pending: PendingInteraction = {
      interactionId,
      kind: "permission",
      anchorRowId: this.deps.anchorRowIdOf?.(frame.toolCallId) ?? null,
      createdAt: Date.now(),
      payload: {
        kind: "permission",
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        summary,
        detail: frame.input,
        // 拒绝理由回传 omp（permission_response.feedback 附给模型）。
        freeText: true,
        ...(origin ? { origin } : {}),
        options: options.map((option) => ({
          optionId: option.optionId,
          label: option.label,
          kind: option.kind,
          response: permissionOptionsResponseOf(option),
        })),
      },
    };
    this.deps.addPendingInteraction(pending);
    this.deps.scheduleFlush();
    const wireOptions = options.map((option) => ({
      optionId: option.optionId,
      kind: option.omp,
      name: option.label,
      response: permissionOptionsResponseOf(option),
    }));
    const answer = await this.awaitAnswer(interactionId, frame.id, "permission", () =>
      this.deps.gateway.requestPermission
        ? this.deps.gateway
            .requestPermission({
              requestId: interactionId,
              sessionId: this.deps.sessionId,
              toolCallId: frame.toolCallId,
              toolName: frame.toolName,
              reason: summary,
              riskLevel: permissionRiskLevelOf(frame.tier),
              input: frame.input,
              ...(origin ? { origin } : {}),
              options: wireOptions,
            })
            .then((hostAnswer) => this.settle(interactionId, permissionHostAnswerOf(hostAnswer)))
            .catch(() => this.settle(interactionId, { action: "cancel" }))
        : Promise.resolve(),
    );
    request.respond(permissionResponseOf(frame, options, answer));
  }

  /** v3 富 ask：完整问题集一次下发，投影为 ElicitationDialog 富问答。 */
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
    const prompt = frame.note?.trim() || frame.questions[0]?.question || "ask";
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
        pause: () => request.pause(),
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
   * reverseRequest 负责发起宿主反向请求并把应答汇入 settle；无反向请求面时传空操作。
   */
  private awaitAnswer(
    interactionId: string,
    ompRequestId: string,
    kind: WaitingInteraction["kind"],
    reverseRequest: () => Promise<unknown>,
    ask?: { pause: () => void; onExpire?: () => void; deadlineAt?: number },
  ): Promise<HostUserInputAnswer> {
    return new Promise<HostUserInputAnswer>((resolve) => {
      const timer = this.startWaitBudgetTimer(interactionId, resolve);
      const entry: WaitingInteraction = {
        ompRequestId,
        kind,
        resolve,
        timer,
        ...(ask ? { pause: ask.pause } : {}),
      };
      if (ask?.deadlineAt && ask.deadlineAt > Date.now()) {
        const expireTimer = setTimeout(() => {
          // 服务端到期自动收尾：仅本地清场；snooze（ask_pause）会取消该定时器。
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

  /** S5-3：本地等待预算定时器；snooze 顺延即重挂一个完整预算周期。 */
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

  /** v4 snoozeInteractionAutoResolution 入口：ask 首次交互幂等暂停两侧倒计时。 */
  snooze(interactionId: string): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry || entry.kind !== "ask") {
      return false;
    }
    entry.pause?.();
    if (entry.expireTimer) {
      clearTimeout(entry.expireTimer);
      entry.expireTimer = undefined;
    }
    // S5-3：snooze 表示用户正在作答（ask_pause 已幂等暂停服务端倒计时），
    // 本地等待预算同步顺延一个完整周期，避免用户作答途中被兜底定时器取消。
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
