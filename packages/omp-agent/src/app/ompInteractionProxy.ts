// omp 扩展 UI 请求（select/confirm/input）→ ZCode pendingInteraction + 宿主反向请求的代理。
// 应答有两条汇入路径：宿主直接应答 interaction/requestUserInput，或 UI 经 v4 resolveInteraction
// 命令回执；两者汇合到同一个 deferred，先到先用；180s 兜底取消（对齐 ZCode CLI 侧交互超时口径）。

import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { createInteractionId } from "../domain/ids.js";
import type { OmpUiRequest } from "./ports.js";
import type { HostGateway, HostUserInputAnswer } from "./ports.js";

interface InteractionDeps {
  sessionId: string;
  gateway: HostGateway;
  addPendingInteraction: (interaction: PendingInteraction) => void;
  resolvePendingInteraction: (interactionId: string) => void;
  scheduleFlush: () => void;
}

export class OmpInteractionProxy {
  private readonly interactions = new Map<
    string,
    {
      ompRequestId: string;
      resolve: (answer: HostUserInputAnswer) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly deps: InteractionDeps) {}

  async handle(request: OmpUiRequest): Promise<void> {
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
    this.deps.addPendingInteraction(pending);
    this.deps.scheduleFlush();
    const answer = await new Promise<HostUserInputAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.interactions.delete(interactionId);
        resolve({ action: "cancel" });
      }, 180_000);
      timer.unref?.();
      this.interactions.set(interactionId, { ompRequestId: request.frame.id, resolve, timer });
      this.deps.gateway
        .requestUserInput({
          requestId: interactionId,
          sessionId: this.deps.sessionId,
          prompt,
          ...(options ? { options } : {}),
        })
        .then((hostAnswer) => this.settle(interactionId, hostAnswer))
        .catch(() => this.settle(interactionId, { action: "cancel" }));
    });
    this.deps.resolvePendingInteraction(interactionId);
    this.deps.scheduleFlush();
    request.respond(toOmpUiResponse(request, answer));
  }

  /** v4 resolveInteraction 命令入口：把 UI 应答汇入等待中的交互。 */
  settle(interactionId: string, answer: HostUserInputAnswer): boolean {
    const entry = this.interactions.get(interactionId);
    if (!entry) {
      return false;
    }
    this.interactions.delete(interactionId);
    clearTimeout(entry.timer);
    entry.resolve(answer);
    return true;
  }

  /** 引擎销毁：全部交互按取消收口，避免 omp 侧等待悬挂。 */
  dispose(): void {
    for (const entry of this.interactions.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ action: "cancel" });
    }
    this.interactions.clear();
  }
}

function toOmpUiResponse(request: OmpUiRequest, answer: HostUserInputAnswer) {
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
