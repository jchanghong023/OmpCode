// omp 帧分发（自 ompProcess.ts 拆出）：按帧类型 schema 校验并路由到命令结算、
// /context 侧信道、会话事件与 UI 请求处理。

import {
  ompAvailableCommandsFrameSchema,
  ompCommandOutputFrameSchema,
  ompConfigUpdateFrameSchema,
  ompPromptResultFrameSchema,
  ompResponseFrameSchema,
  ompSessionEventFrameSchema,
  ompSessionInfoUpdateFrameSchema,
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

/** safeParse 失败的 issue 摘要（首条 path+message，不含载荷，避免敏感内容入日志）。 */
function issueSummary(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  const issue = error.issues[0];
  if (!issue) {
    return "<no issues>";
  }
  return `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`;
}

/** 分发所需的进程存活状态与回调面（OmpChildProcess 的窄视图；上下文槽位经 getter 实时读取）。 */
export interface OmpFrameDispatchDeps {
  promptResults: PromptResultTracker;
  getContextResult(): { id: string; resolve: (local: boolean) => void } | null;
  getContextOutput(): string[] | null;
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
        // 修复（S3-3）：响应帧校验失败留痕，否则命令只能以超时收场却查不到协议面原因。
        logger.debug("omp response frame rejected", {
          issues: parsed.error.issues.length,
          first: issueSummary(parsed.error),
        });
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
        // 修复（S3-3）：prompt_result 校验失败留痕（含 issue 摘要，不含载荷），
        // 否则轮次收口缺失只表现为「无终态」而无法归因协议面。
        logger.debug("omp prompt_result frame rejected", {
          issues: parsed.error.issues.length,
          first: issueSummary(parsed.error),
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
        logger.warn("invalid available_commands_update", { issues: parsed.error.issues.length });
      }
      return;
    }
    case "command_output": {
      const parsed = ompCommandOutputFrameSchema.safeParse(record);
      if (!parsed.success) {
        // 修复（S3-3）：command_output 校验失败留痕（B2 只覆盖了会话事件帧）。
        logger.debug("omp command_output frame rejected", {
          issues: parsed.error.issues.length,
          first: issueSummary(parsed.error),
        });
        return;
      }
      const contextOutput = deps.getContextOutput();
      if (contextOutput) {
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
      }
      return;
    }
    case "config_update": {
      const parsed = ompConfigUpdateFrameSchema.safeParse(record);
      if (parsed.success) {
        deps.options.onConfigUpdate?.(parsed.data);
      }
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
      else logger.warn("invalid omp subagent frame", { issues: parsed.error.issues.length });
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
        // 修复（B2）：未知/畸形会话事件帧不再静默吞掉，统一 debug（高频诊断不落盘语义），
        // 便于排查「omp 下发了但适配器不消费」的协议面。
        logger.debug("omp session frame rejected", {
          type: String(record.type),
          issues: parsed.error.issues.length,
        });
      }
      return;
    }
  }
}
