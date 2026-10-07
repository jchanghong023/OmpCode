// omp 反向 UI 请求帧的解析与回调分发（extension_ui_request）。
// 解析失败 best-effort 回终止响应（omp 侧等待无超时，静默吞帧会让对端永久等待，
// rpc-ui-protocol「未知交互不能静默忽略，应回传不支持以终止等待」）；
// 应答经统一旁路帧写回（respond 回调由进程适配器提供）。

import { ompExtensionUiRequestFrameSchema } from "../domain/ompFrames.js";
import type { OmpBypassFrame } from "../domain/ompForkFrames.js";
import type { OmpAskRequest, OmpUiRequest } from "../app/ports.js";
import { logger } from "./logger.js";

export interface OmpUiFrameHandlers {
  onUiRequest: (request: OmpUiRequest) => void;
  onAskRequest?: (request: OmpAskRequest) => void;
  /** 旁路帧写回（extension_ui_response 各变体，含富 ask 的 answers）。 */
  respond: (frame: OmpBypassFrame) => void;
}

/** 消费反向 UI 请求帧；非该类帧返回 false 交回主分发。 */
export function dispatchOmpUiFrame(
  record: Record<string, unknown>,
  handlers: OmpUiFrameHandlers,
): boolean {
  if (record.type !== "extension_ui_request") {
    return false;
  }
  const parsed = ompExtensionUiRequestFrameSchema.safeParse(record);
  if (!parsed.success) {
    // 修复（B1）：未知 method/畸形字段不能静默吞帧——omp 侧对该请求的等待无超时，
    // 帧被丢弃会让对端永久挂起。best-effort 从原始 record 取 id 回 cancelled 终止响应；
    // id 缺失时无法回执，保持 warn（对端仅能靠自身超时兜底）。
    logger.warn("invalid extension_ui_request", { issues: parsed.error.issues.length });
    respondTerminal(record, handlers.respond);
    return true;
  }
  const frame = parsed.data;
  if (frame.method === "ask" && frame.questions && frame.questions.length > 0) {
    // 富 ask（set_ask_dialog 启用后）：完整问题集一次下发。
    handlers.onAskRequest?.({
      frame: {
        id: frame.id,
        questions: frame.questions,
        ...(typeof frame.timeout === "number" ? { timeoutMs: frame.timeout } : {}),
      },
      respond: handlers.respond,
    });
    return true;
  }
  handlers.onUiRequest({ frame, respond: handlers.respond });
  return true;
}

/** 解析失败兜底：从原始 record best-effort 取 id（string 时）回 cancelled；id 缺失不回执。 */
function respondTerminal(
  record: Record<string, unknown>,
  respond: (frame: OmpBypassFrame) => void,
): void {
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    return;
  }
  respond({ type: "extension_ui_response", id, cancelled: true });
}
