import { logger } from "./logger.js";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import type { HostUserInputAnswer } from "../app/ports.js";

// Host 协议日志只观察已知标识和形状，不能把 params/result/raw frame 带入日志。
export function hostRequestContext(
  requestId: string | number,
  method: string,
  params: unknown,
): Record<string, unknown> {
  const context: Record<string, unknown> = { requestId, method };
  if (typeof params !== "object" || params === null) return context;
  const record = params as Record<string, unknown>;
  // v4 信封就在 params 顶层；nested envelope 不是真实命令协议，不能串错关联。
  for (const key of ["sessionId", "commandId"] as const) {
    if (typeof record[key] === "string") context[key] = record[key];
  }
  if (
    method === "v4/command" &&
    typeof record.type === "string" &&
    Object.hasOwn(commandPayloadSchemas, record.type)
  ) {
    context.commandType = record.type;
  }
  return context;
}

export function safeResultSummary(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { resultType: "empty" };
  if (Array.isArray(value)) return { resultType: "array", resultCount: value.length };
  if (typeof value !== "object") return { resultType: typeof value };
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = { resultType: "object" };
  if (typeof record.success === "boolean") summary.success = record.success;
  if (typeof record.available === "boolean") summary.available = record.available;
  if (typeof record.truncated === "boolean") summary.truncated = record.truncated;
  if (Array.isArray(record.entries)) summary.entryCount = record.entries.length;
  if (
    typeof record.status === "string" &&
    ["accepted", "rejected", "stale", "duplicate", "noop", "failed"].includes(record.status)
  )
    summary.status = record.status;
  return summary;
}

export function safeErrorSummary(error: unknown): Record<string, unknown> {
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; name?: unknown })
      : null;
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof record?.code === "number" || typeof record?.code === "string"
      ? { code: record.code }
      : {}),
  };
}

export function safeInteractionAction(result: unknown): string {
  if (typeof result !== "object" || result === null) return "unknown";
  const action = (result as Record<string, unknown>).action;
  return action === "accept" || action === "decline" || action === "cancel" ? action : "unknown";
}

/** 文件操作结果只记类型/计数，既有 fallback 由原调用点决定并记录。 */
export async function observeStoreOperation<T>(
  operation: string,
  fields: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const emit = operation === "readInteraction" ? logger.debug : logger.info;
  emit("OMP 文件操作开始", { event: `omp.store.${operation}.started`, ...fields });
  try {
    const result = await callback();
    emit("OMP 文件操作结束", {
      event: `omp.store.${operation}.result`,
      ...fields,
      elapsedMs: Date.now() - startedAt,
      ...safeResultSummary(result),
      ...(typeof result === "boolean" ? { success: result } : {}),
    });
    return result;
  } catch (error) {
    logger.error("OMP 文件操作失败", {
      event: `omp.store.${operation}.failed`,
      ...fields,
      stage: "file",
      elapsedMs: Date.now() - startedAt,
      ...safeErrorSummary(error),
    });
    throw error;
  }
}

export function logHostRequestResult(
  result: unknown,
  elapsedMs: number,
  transportClosed: boolean,
): void {
  logger.info("Host 请求响应", {
    event: "host.request.response",
    elapsedMs,
    transportClosed,
    ...safeResultSummary(result),
  });
}

export function logHostRequestFailure(
  error: unknown,
  code: number,
  stage: string,
  elapsedMs: number,
): void {
  logger.error("Host 请求处理失败", {
    event: "host.request.failed",
    ...safeErrorSummary(error),
    code,
    stage,
    elapsedMs,
  });
}

export function logHostInteraction(
  event: "started" | "response" | "error" | "timeout" | "disconnect",
  context: Record<string, unknown>,
  startedAt: number,
  stage: string,
  summary: Record<string, unknown> = {},
): void {
  logger.run(context, () => {
    const emit = event === "started" || event === "response" ? logger.info : logger.error;
    emit(`Host 交互 ${event}`, {
      event: `host.interaction.${event}`,
      stage,
      elapsedMs: Date.now() - startedAt,
      ...summary,
    });
  });
}

/** 观察输出异常后原样抛出，不吞掉编码或 backpressure 队列异常。 */
export function observeHostOutput<T>(stage: string, callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    logger.error("Host 输出失败", {
      event: "host.protocol.output.failed",
      stage,
      ...safeErrorSummary(error),
    });
    throw error;
  }
}

// 保留协议原有 accept/decline/cancel 正规化，摘要与答案始终分离。
export function userInputAnswerOf(result: unknown): HostUserInputAnswer {
  if (typeof result !== "object" || result === null) {
    return { action: "cancel" };
  }
  const record = result as { action?: unknown; content?: unknown };
  if (record.action === "accept" || record.action === "decline" || record.action === "cancel") {
    const content =
      typeof record.content === "object" &&
      record.content !== null &&
      !Array.isArray(record.content)
        ? (record.content as Record<string, unknown>)
        : undefined;
    const optionId = typeof content?.optionId === "string" ? content.optionId : undefined;
    const freeText =
      typeof content?.freeText === "string"
        ? content.freeText
        : typeof content?.value === "string"
          ? content.value
          : undefined;
    return record.action === "accept"
      ? { action: "accept", optionId, freeText, ...(content ? { content } : {}) }
      : { action: record.action };
  }
  return { action: "cancel" };
}

/** 调度分类沿用原协议服务器规则，不用日志信封解释改变既有队列。 */
export function requestQueueKey(params: unknown): string {
  if (typeof params !== "object" || params === null) return "workspace";
  const record = params as Record<string, unknown>;
  const envelope = record.envelope;
  const nested =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)
      : null;
  const sessionId = nested?.sessionId ?? record.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) return `conversation/${sessionId}`;
  const topic = record.topic;
  if (typeof topic === "string" && topic.length > 0) return topic;
  return "workspace";
}

export function isInteractionControlRequest(method: string, params: unknown): boolean {
  if (method !== "v4/command" || typeof params !== "object" || params === null) return false;
  const record = params as Record<string, unknown>;
  // 只分类顶层控制回路，完整业务信封验证仍交给原 handleRequest。
  return record.type === "resolveInteraction" || record.type === "stop";
}

export function logStoreFallback(
  operation: string,
  stage: string,
  startedAt: number,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  const emit = operation === "delete" ? logger.error : logger.warn;
  emit("OMP 文件操作沿用既有降级结果", {
    event: `omp.store.${operation}.${operation === "delete" ? "failed" : "fallback"}`,
    stage,
    elapsedMs: Date.now() - startedAt,
    ...safeErrorSummary(error),
    ...fields,
  });
}

let debugFileWarningEmitted = false;

/** 集中安全字段/稳定事件，服务器只保留原传输和调度状态。 */
export const hostDiagnostics = {
  debugFileDisabled(): void {
    if (debugFileWarningEmitted) return;
    debugFileWarningEmitted = true;
    logger.warn("原始协议文件日志已禁用", {
      event: "host.protocol.debugFile.disabled",
      stage: "configuration",
    });
  },
  frame(direction: "received" | "sent", line: string): void {
    logger.debug("Host 协议帧摘要", {
      event: "host.protocol.frame",
      direction,
      byteLength: Buffer.byteLength(line),
    });
  },
  invalidJson(line: string): void {
    logger.warn("Host 帧不是 JSON", {
      event: "host.protocol.invalidJson",
      stage: "decode",
      byteLength: Buffer.byteLength(line),
    });
  },
  notificationFailed(method: string, error: unknown): void {
    logger.error("Host 通知处理失败", {
      event: "host.notification.failed",
      method,
      stage: "notification",
      ...safeErrorSummary(error),
    });
  },
  received(control: boolean): void {
    logger.info("Host 请求接收并入队", {
      event: "host.request.received",
      stage: "enqueue",
      control,
    });
  },
  started(queueWaitMs: number): void {
    logger.info("Host 请求开始处理", { event: "host.request.started", queueWaitMs });
  },
  backpressureStarted(): void {
    logger.warn("Host 输出等待 drain", {
      event: "host.protocol.backpressure.started",
      stage: "send",
    });
  },
  backpressureFailed(bufferedBytes: number, elapsedMs: number): void {
    logger.error("Host 输出缓冲饱和", {
      event: "host.protocol.backpressure.failed",
      stage: "send",
      bufferedBytes,
      elapsedMs,
    });
  },
  backpressureDrained(elapsedMs: number): void {
    logger.info("Host 输出已排空", {
      event: "host.protocol.backpressure.drained",
      stage: "send",
      elapsedMs,
    });
  },
  closed(pendingCount: number, error: unknown, elapsedMs: number): void {
    logger.info("Host 传输关闭", {
      event: "host.protocol.closed",
      stage: "disconnect",
      pendingCount,
      elapsedMs,
      ...safeErrorSummary(error),
    });
  },
};
