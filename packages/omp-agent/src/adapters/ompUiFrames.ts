// omp 反向 UI 请求帧的解析与回调分发（extension_ui_request / permission_request / ask_request）。
// 解析失败仅告警丢弃；应答经统一旁路帧写回（respond 回调由进程适配器提供）。

import { ompExtensionUiRequestFrameSchema } from "../domain/ompFrames.js";
import {
  ompAskRequestFrameSchema,
  ompPermissionRequestFrameSchema,
  type OmpBypassFrame,
} from "../domain/ompForkFrames.js";
import type { OmpAskRequest, OmpPermissionRequest, OmpUiRequest } from "../app/ports.js";
import { logger } from "./logger.js";

export interface OmpUiFrameHandlers {
  onUiRequest: (request: OmpUiRequest) => void;
  onPermissionRequest?: (request: OmpPermissionRequest) => void;
  onAskRequest?: (request: OmpAskRequest) => void;
  /** 旁路帧写回（extension_ui_response / permission_response / ask_response / ask_pause）。 */
  respond: (frame: OmpBypassFrame) => void;
}

/** 消费三类反向 UI 请求帧；非该类帧返回 false 交回主分发。 */
export function dispatchOmpUiFrame(
  record: Record<string, unknown>,
  handlers: OmpUiFrameHandlers,
): boolean {
  if (record.type === "extension_ui_request") {
    const parsed = ompExtensionUiRequestFrameSchema.safeParse(record);
    if (!parsed.success) {
      logger.warn("invalid extension_ui_request", { issues: parsed.error.issues.length });
      return true;
    }
    handlers.onUiRequest({ frame: parsed.data, respond: handlers.respond });
    return true;
  }
  if (record.type === "permission_request") {
    // v3 fork surface：结构化审批（rpc-ui-protocol 4.1）；仅协商 v3 后 omp 才会下发。
    const parsed = ompPermissionRequestFrameSchema.safeParse(record);
    if (!parsed.success) {
      logger.warn("invalid permission_request", { issues: parsed.error.issues.length });
      return true;
    }
    handlers.onPermissionRequest?.({ frame: parsed.data, respond: handlers.respond });
    return true;
  }
  if (record.type === "ask_request") {
    // v3 fork surface：富 ask 完整问题集（rpc-ui-protocol 4.3）。
    const parsed = ompAskRequestFrameSchema.safeParse(record);
    if (!parsed.success) {
      logger.warn("invalid ask_request", { issues: parsed.error.issues.length });
      return true;
    }
    handlers.onAskRequest?.({
      frame: parsed.data,
      respond: handlers.respond,
      pause: () => {
        handlers.respond({ type: "ask_pause", targetId: parsed.data.id });
      },
    });
    return true;
  }
  return false;
}
