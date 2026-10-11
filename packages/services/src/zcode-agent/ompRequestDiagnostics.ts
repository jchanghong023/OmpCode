import type { ZCodeProtocolRequestId } from "@zcode/shared";
import {
  sanitizeOmpDiagnosticFields,
  summarizeOmpDiagnosticResult,
  writeOmpHostDiagnostic,
  type OmpDiagnosticHostContext,
} from "./ompDiagnosticLog.js";

/** 只读诊断事实；pending、计时器和请求终态仍由 ProtocolClient 唯一拥有。 */
export interface OmpRequestDiagnosticContext {
  readonly observation: boolean;
  readonly startedAt: number;
  readonly diagnosticFields: Record<string, unknown>;
}

export function createOmpRequestDiagnosticFields(
  host: OmpDiagnosticHostContext | undefined,
  params: unknown,
  fields: {
    requestId: ZCodeProtocolRequestId;
    method: string;
    traceId?: string;
    timeoutMs: number;
    lifecycle: "observation" | "operation";
  },
): Record<string, unknown> {
  // params 只取既有关联 ID；请求正文、附件、外部 traceparent 不进入诊断。
  const requestParams =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return sanitizeOmpDiagnosticFields({
    ...host,
    peerPid: host?.agentPid,
    requestId: fields.requestId,
    method: fields.method,
    traceId: fields.traceId,
    sessionId: requestParams.sessionId,
    commandId: requestParams.commandId,
    inputId: requestParams.inputId,
    taskId: requestParams.taskId,
    runId: requestParams.runId,
    queryId: requestParams.queryId,
    turnId: requestParams.turnId,
    ownerRunId: requestParams.ownerRunId,
    timeoutMs: fields.timeoutMs,
    lifecycle: fields.lifecycle,
  });
}

export function logOmpRequestStarted(
  diagnosticFields: Record<string, unknown>,
  observation: boolean,
): void {
  writeOmpHostDiagnostic(observation ? "debug" : "info", "omp_host_request_started", {
    ...diagnosticFields,
    stage: "send",
    elapsedMs: 0,
  });
}

export function logOmpRequestCompleted(
  pending: OmpRequestDiagnosticContext,
  result: unknown,
): void {
  writeOmpHostDiagnostic(pending.observation ? "debug" : "info", "omp_host_request_completed", {
    ...pending.diagnosticFields,
    ...summarizeOmpDiagnosticResult(result),
    success: true,
    stage: "response_decoded",
    elapsedMs: Math.max(0, Date.now() - pending.startedAt),
  });
}

export function logOmpRequestFailure(
  pending: OmpRequestDiagnosticContext,
  stage: string,
  error: unknown,
): void {
  // 最终错误只输出名称/代码与安全文本；远端 data、Zod issue 输入和 params 不复制。
  writeOmpHostDiagnostic(stage === "cancel" ? "warn" : "error", "omp_host_request_failed", {
    ...pending.diagnosticFields,
    success: false,
    stage,
    elapsedMs: Math.max(0, Date.now() - pending.startedAt),
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode:
      error instanceof Error && "code" in error
        ? (error as Error & { code?: unknown }).code
        : undefined,
    ...(stage !== "decode" && error instanceof Error ? { errorMessage: error.message } : {}),
  });
}
