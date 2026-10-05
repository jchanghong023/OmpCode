// omp 反向 UI 请求帧的解析与回调分发（extension_ui_request / permission_request / ask_request）。
// 解析失败 best-effort 回终止响应（omp 侧权限门 await 无超时，静默吞帧会让对端永久等待，
// rpc-ui-protocol §14.2「未知交互不能静默忽略，应回传不支持以终止等待」）；
// 应答经统一旁路帧写回（respond 回调由进程适配器提供）。

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
      // 修复（B1）：未知 method/畸形字段不能静默吞帧——omp 侧对该请求的等待无超时，
      // 帧被丢弃会让对端永久挂起。best-effort 从原始 record 取 id 回 cancelled 终止响应；
      // id 缺失时无法回执，保持 warn（对端仅能靠自身超时兜底）。
      logger.warn("invalid extension_ui_request", { issues: parsed.error.issues.length });
      respondTerminal(record, handlers.respond, (id) => ({
        type: "extension_ui_response",
        id,
        cancelled: true,
      }));
      return true;
    }
    handlers.onUiRequest({ frame: parsed.data, respond: handlers.respond });
    return true;
  }
  if (record.type === "permission_request") {
    // v3 fork surface：结构化审批（rpc-ui-protocol 4.1）；仅协商 v3 后 omp 才会下发。
    const parsed = ompPermissionRequestFrameSchema.safeParse(record);
    if (!parsed.success) {
      // 修复（B1）：结构化审批帧解析失败必须 fail-closed 回 reject_once 终止 omp 侧
      // 权限门等待（rpc-fork-permission 的 await 无超时），不得吞帧。
      logger.warn("invalid permission_request", { issues: parsed.error.issues.length });
      respondTerminal(record, handlers.respond, (id) => ({
        type: "permission_response",
        id,
        option: "reject_once",
      }));
      return true;
    }
    handlers.onPermissionRequest?.({ frame: parsed.data, respond: handlers.respond });
    return true;
  }
  if (record.type === "ask_request") {
    // v3 fork surface：富 ask 完整问题集（rpc-ui-protocol 4.3）。
    const parsed = ompAskRequestFrameSchema.safeParse(record);
    if (!parsed.success) {
      // 修复（B1）：富 ask 帧解析失败回 cancelled 终止等待（同上，等待方无超时）。
      logger.warn("invalid ask_request", { issues: parsed.error.issues.length });
      respondTerminal(record, handlers.respond, (id) => ({
        type: "ask_response",
        id,
        cancelled: true,
      }));
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

/** 解析失败兜底：从原始 record best-effort 取 id（string 时）回终止响应；id 缺失不回执。 */
function respondTerminal(
  record: Record<string, unknown>,
  respond: (frame: OmpBypassFrame) => void,
  terminal: (id: string) => OmpBypassFrame,
): void {
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    return;
  }
  respond(terminal(id));
}
