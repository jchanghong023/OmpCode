import { basename } from "node:path";
import { logger } from "./logger.js";

// 仅保存请求起点的诊断上下文；pending、timer 与命令结算仍由 OmpChildProcess 拥有。
export interface OmpRpcDiagnostic {
  fields: Record<string, unknown>;
  startedAt: number;
  commandType: string;
  finalized: boolean;
  decodeFailed?: boolean;
}

function rpcSuccessLevel(commandType: string): "debug" | "info" {
  return commandType === "get_state" ||
    commandType === "get_subagent_messages" ||
    commandType === "get_subagents"
    ? "debug"
    : "info";
}

export function ompCoreFields(
  sessionId: unknown,
  coreInstanceId: string,
  peerPid: number | undefined,
  options: { cwd: string; resumeSessionPath?: string; sessionless?: boolean },
  binaryPath: string,
  extraArgumentCount: number,
): Record<string, unknown> {
  return {
    sessionId,
    coreInstanceId,
    peerPid,
    cwd: options.cwd,
    resumePresent: Boolean(options.resumeSessionPath),
    sessionless: options.sessionless === true,
    // 路径经过唯一 logger 的脱敏与长度预算，不记录任何参数值。
    binary: basename(binaryPath),
    executable: binaryPath,
    argumentCount:
      extraArgumentCount + 2 + (options.sessionless ? 1 : 0) + (options.resumeSessionPath ? 2 : 0),
  };
}

export function startOmpRpc(
  coreFields: Record<string, unknown>,
  commandType: string,
  timeoutMs: number,
  ompRequestId: string | null,
): OmpRpcDiagnostic {
  const diagnostic: OmpRpcDiagnostic = {
    fields: {
      requestId: undefined,
      commandId: undefined,
      inputId: undefined,
      traceId: undefined,
      ...coreFields,
      ...logger.context(),
      coreInstanceId: coreFields.coreInstanceId,
      peerPid: coreFields.peerPid,
      commandType,
      timeoutMs,
      ompRequestId,
    },
    startedAt: Date.now(),
    commandType,
    finalized: false,
  };
  logger[rpcSuccessLevel(commandType)]("omp_rpc_started", {
    ...diagnostic.fields,
    event: "omp_rpc_started",
    elapsedMs: 0,
  });
  return diagnostic;
}

export function finishOmpRpc(
  diagnostic: OmpRpcDiagnostic,
  success: boolean,
  stage: string,
  fields?: Record<string, unknown>,
): void {
  if (diagnostic.finalized) return;
  diagnostic.finalized = true;
  const event = success ? "omp_rpc_completed" : "omp_rpc_failed";
  const level = !success ? "error" : rpcSuccessLevel(diagnostic.commandType);
  logger[level](event, {
    ...diagnostic.fields,
    ...fields,
    event,
    success,
    stage,
    elapsedMs: Date.now() - diagnostic.startedAt,
  });
}

export function finishOmpRpcResponse(
  diagnostic: OmpRpcDiagnostic,
  success: boolean,
  data: { data?: unknown; error?: string; code?: unknown },
): void {
  finishOmpRpc(diagnostic, success, success ? "response" : "remote", {
    error: data.error,
    errorCode: data.code,
    resultType: data.data === null ? "null" : Array.isArray(data.data) ? "array" : typeof data.data,
    ...(Array.isArray(data.data)
      ? { resultCount: data.data.length }
      : typeof data.data === "string"
        ? { resultLength: data.data.length }
        : data.data && typeof data.data === "object"
          ? { resultFieldCount: Object.keys(data.data).length }
          : typeof data.data === "boolean"
            ? { resultBoolean: data.data }
            : {}),
  });
}

export function logOmpCoreExit(
  coreFields: Record<string, unknown>,
  code: number | null,
  signal: NodeJS.Signals | null,
  stage: string,
  disposed: boolean,
  spawnAt: number,
): void {
  logger[disposed ? "info" : "error"]("omp_core_exited", {
    ...coreFields,
    event: "omp_core_exited",
    requestId: undefined,
    commandId: undefined,
    inputId: undefined,
    traceId: undefined,
    code,
    signal,
    stage,
    elapsedMs: Date.now() - spawnAt,
  });
}

export function logOmpCoreSubscription(
  coreFields: Record<string, unknown>,
  success: boolean,
  forkSurface: boolean | undefined,
  error: string | undefined,
  spawnAt: number,
): void {
  logger[success ? "info" : "warn"]("omp_core_subscription_completed", {
    ...coreFields,
    event: "omp_core_subscription_completed",
    stage: "subscription",
    subagentSubscriptionAvailable: success,
    forkSurface: forkSurface === true,
    protocolVersion: forkSurface ? 3 : undefined,
    error,
    elapsedMs: Date.now() - spawnAt,
  });
}
