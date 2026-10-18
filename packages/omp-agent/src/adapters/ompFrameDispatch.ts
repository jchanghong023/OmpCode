// omp 帧分发（自 ompProcess.ts 拆出）：按帧类型 schema 校验并路由到命令结算、
// /context 侧信道、会话事件与 UI 请求处理。

import {
  ompAvailableCommandsFrameSchema,
  ompBtwFrameSchema,
  ompCommandOutputFrameSchema,
  ompConfigUpdateFrameSchema,
  ompPromptResultFrameSchema,
  ompResponseFrameSchema,
  ompSessionEventFrameSchema,
  ompSessionInfoUpdateFrameSchema,
  ompSettingsChangedFrameSchema,
  ompSubagentFrameSchema,
  type OmpConfigUpdateFrame,
  type OmpPromptResultFrame,
  type OmpSessionEventFrame,
  type OmpSessionInfoUpdateFrame,
  type OmpSubagentFrame,
} from "../domain/ompFrames.js";
import type { OmpBypassFrame } from "../domain/ompForkFrames.js";
import type { PromptResultTracker } from "../domain/promptResultTracker.js";
import type { OmpAskRequest, OmpUiRequest } from "../app/ports.js";
import { dispatchOmpUiFrame } from "./ompUiFrames.js";
import { logger } from "./logger.js";
import type { OmpBtwFrame } from "../domain/OmpBtwFrames.js";
import { parseOmpContextReport } from "../domain/ompContextReport.js";

/** 分发所需的进程存活状态与回调面（OmpChildProcess 的窄视图；上下文槽位经 getter 实时读取）。 */
export interface OmpFrameDispatchDeps {
  promptResults: PromptResultTracker;
  getContextResult(): { id: string; resolve: (local: boolean) => void } | null;
  getContextOutput(): string[] | null;
  /** 仅观察畸形响应，不提前 settle；原等待/超时语义保持。 */
  onResponseDecodeFailure(id: string | undefined, issueCount: number): void;
  settleCommand(
    id: string,
    success: boolean,
    data: { data?: unknown; error?: string; code?: unknown },
  ): void;
  options: {
    onEvent: (event: OmpSessionEventFrame) => void;
    onUiRequest: (request: OmpUiRequest) => void;
    onAskRequest?: (request: OmpAskRequest) => void;
    onPromptResult?: (frame: OmpPromptResultFrame) => void;
    onCommandOutput?: (frame: { text: string }) => void;
    onSessionInfoUpdate?: (frame: OmpSessionInfoUpdateFrame) => void;
    onConfigUpdate?: (frame: OmpConfigUpdateFrame) => void;
    onCommandsUpdate?: (commands: unknown) => void;
    onSubagentFrame?: (frame: OmpSubagentFrame) => void;
    onBtwFrame?: (frame: OmpBtwFrame) => void;
  };
  respondUi(response: OmpBypassFrame): void;
}

export function dispatchOmpFrame(frame: unknown, deps: OmpFrameDispatchDeps): void {
  if (typeof frame !== "object" || frame === null) {
    return;
  }
  const record = frame as Record<string, unknown>;
  switch (record.type) {
    case "response": {
      const parsed = ompResponseFrameSchema.safeParse(record);
      if (!parsed.success) {
        // 解码失败仍由原 pending 等待收口；诊断回调关联发出时的请求上下文。
        deps.onResponseDecodeFailure(
          typeof record.id === "string" ? record.id : undefined,
          parsed.error.issues.length,
        );
        return;
      }
      if (parsed.data.id) {
        deps.promptResults.noteResponse(parsed.data);
        deps.settleCommand(parsed.data.id, parsed.data.success, parsed.data);
      }
      return;
    }
    case "prompt_result": {
      const parsed = ompPromptResultFrameSchema.safeParse(record);
      if (!parsed.success) {
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "prompt_result",
          issueCount: parsed.error.issues.length,
        });
        return;
      }
      const contextResult = deps.getContextResult();
      if (parsed.data.id && parsed.data.id === contextResult?.id) {
        contextResult.resolve(parsed.data.agentInvoked === false);
        return;
      }
      if (deps.promptResults.shouldFinish(parsed.data)) {
        deps.options.onPromptResult?.(parsed.data);
      }
      return;
    }
    case "available_commands_update": {
      const parsed = ompAvailableCommandsFrameSchema.safeParse(record);
      if (parsed.success) {
        deps.options.onCommandsUpdate?.(parsed.data.commands);
      } else {
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "available_commands_update",
          issueCount: parsed.error.issues.length,
        });
      }
      return;
    }
    case "command_output": {
      const parsed = ompCommandOutputFrameSchema.safeParse(record);
      if (!parsed.success) {
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "command_output",
          issueCount: parsed.error.issues.length,
        });
        return;
      }
      const contextOutput = deps.getContextOutput();
      // 原生 /context 整帧返回报告；等待窗口内仍会穿插计划退出等背景输出，
      // 无 requestId 不能把全部 command_output 吞入报告，否则业务已完成却不可见。
      if (contextOutput && parseOmpContextReport(parsed.data.text)) {
        contextOutput.push(parsed.data.text);
        return;
      }
      deps.options.onCommandOutput?.({ text: parsed.data.text });
      return;
    }
    case "session_info_update": {
      const parsed = ompSessionInfoUpdateFrameSchema.safeParse(record);
      if (parsed.success) {
        deps.options.onSessionInfoUpdate?.(parsed.data);
      } else
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "session_info_update",
          issueCount: parsed.error.issues.length,
        });
      return;
    }
    case "config_update": {
      const parsed = ompConfigUpdateFrameSchema.safeParse(record);
      if (parsed.success) {
        deps.options.onConfigUpdate?.(parsed.data);
      } else
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "config_update",
          issueCount: parsed.error.issues.length,
        });
      return;
    }
    case "settings_changed": {
      const parsed = ompSettingsChangedFrameSchema.safeParse(record);
      if (parsed.success) {
        // 通知帧：ZCode 的角色目录始终按 RPC 现读、会话侧设置由核心 reload，
        // 这里只确认收到，不落本地状态，也绝不因它走会话事件分支被拒帧。
        logger.debug("omp_settings_changed", {
          event: "omp_settings_changed",
          scope: parsed.data.scope,
        });
      } else
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: "settings_changed",
          issueCount: parsed.error.issues.length,
        });
      return;
    }
    case "btw_record":
    case "btw_delta":
    case "notice": {
      const parsed = ompBtwFrameSchema.safeParse(record);
      if (parsed.success) deps.options.onBtwFrame?.(parsed.data);
      else
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: String(record.type),
          issueCount: parsed.error.issues.length,
        });
      return;
    }
    case "extension_error":
    case "host_tool_call":
    case "host_tool_cancel":
    case "host_uri_request":
    case "host_uri_cancel":
    case "ready":
      return;
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event": {
      const parsed = ompSubagentFrameSchema.safeParse(record);
      if (parsed.success) deps.options.onSubagentFrame?.(parsed.data);
      else
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: String(record.type),
          issueCount: parsed.error.issues.length,
        });
      return;
    }
    case "extension_ui_request":
      dispatchOmpUiFrame(record, {
        onUiRequest: deps.options.onUiRequest,
        onAskRequest: deps.options.onAskRequest,
        respond: (response) => deps.respondUi(response),
      });
      return;
    default: {
      const parsed = ompSessionEventFrameSchema.safeParse(record);
      if (parsed.success) {
        deps.options.onEvent(parsed.data);
      } else {
        logger.warn("omp_core_frame_decode_failed", {
          event: "omp_core_frame_decode_failed",
          stage: "frame_decode",
          frameType: typeof record.type === "string" ? record.type : typeof record.type,
          issueCount: parsed.error.issues.length,
        });
      }
      return;
    }
  }
}
