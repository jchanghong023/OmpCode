import { isApplicationLogLevelEnabled, redactFeedbackText } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

export type OmpDiagnosticLevel = "debug" | "info" | "warn" | "error";
export interface OmpDiagnosticHostContext {
  workspaceKey: string;
  workspaceIdentity?: string;
  workspacePath: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  agentPid?: number;
}

const agentLogger = createServiceLogger("omp-agent");
const hostLogger = createServiceLogger("omp-host");
const MAX_INPUT_CHARS = 32_768;
const MAX_TEXT_CHARS = 2_000;
const MAX_FIELDS = 80;
const safeEvent = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
let sinkFailureReported = false;

function reportDiagnosticSinkFailure(): void {
  if (sinkFailureReported) return;
  sinkFailureReported = true;
  try {
    // 绕过坏掉的 ServiceLogger，只报静态原因一次；不能递归或复制原记录/异常。
    process.stderr.write(
      `${JSON.stringify({
        ts: Date.now(),
        level: "error",
        scope: "omp-host",
        pid: process.pid,
        event: "omp_host_log_sink_failed",
        message: "ServiceLogger diagnostic delivery failed",
        stage: "log_write",
      })}\n`,
    );
  } catch {
    // stderr 也失效时不重试；诊断故障不能影响业务和进程 fence。
  }
}

// 根因：任意 stderr JSON 不等于日志；正文或伪造 Host 身份不能借转发进入唯一文件 writer。
// stderr 已包含这些安全摘要，原 Host 二次白名单会丢失；仅保留身份、计数和状态，不开放载荷。
const safeFields: Record<string, true> = {
  requestId: true,
  hostRequestId: true,
  traceId: true,
  commandId: true,
  inputId: true,
  sessionId: true,
  taskId: true,
  runId: true,
  ownerRunId: true,
  activeRunId: true,
  coreInstanceId: true,
  ompRequestId: true,
  commandType: true,
  method: true,
  operation: true,
  component: true,
  peerPid: true,
  cwd: true,
  resumePresent: true,
  sessionless: true,
  code: true,
  signal: true,
  elapsedMs: true,
  stage: true,
  terminalStage: true,
  timeoutMs: true,
  success: true,
  status: true,
  resultType: true,
  resultCount: true,
  resultLength: true,
  resultFieldCount: true,
  issueCount: true,
  frameType: true,
  lineLength: true,
  pendingCount: true,
  resultBoolean: true,
  fallbackVersion: true,
  outputLineCount: true,
  protocolVersion: true,
  supportedProtocolVersions: true,
  forkSurface: true,
  subagentSubscriptionAvailable: true,
  askDialogAvailable: true,
  forced: true,
  error: true,
  errorType: true,
  errorCode: true,
  errorName: true,
  errorMessage: true,
  errorStack: true,
  truncated: true,
  reason: true,
  attempt: true,
  subagentId: true,
  parentSessionId: true,
  targetId: true,
  interactionId: true,
  interactionMethod: true,
  toolName: true,
  queueLength: true,
  queueCount: true,
  attachmentCount: true,
  contentLength: true,
  answerCount: true,
  questionCount: true,
  count: true,
  length: true,
  type: true,
  state: true,
  oldState: true,
  newState: true,
  capability: true,
  available: true,
  loaded: true,
  workspaceKey: true,
  workspaceIdentity: true,
  workspacePath: true,
  runtimeGeneration: true,
  runtimeInstanceId: true,
  agentPid: true,
  lifecycle: true,
  accepted: true,
  cancelled: true,
  retryable: true,
  fallback: true,
  source: true,
  interactionRequestId: true,
  queueWaitMs: true,
  control: true,
  transportClosed: true,
  transportFailed: true,
  generation: true,
  currentGeneration: true,
  retryInMs: true,
  argumentCount: true,
  retainedCount: true,
  mode: true,
  valueType: true,
  entryCount: true,
  invalidLineCount: true,
  ancestryDepth: true,
  optionCount: true,
  byteLength: true,
  bufferedBytes: true,
  direction: true,
  action: true,
  routing: true,
  delivery: true,
  phase: true,
  approved: true,
  denied: true,
  fromByte: true,
  nextByte: true,
  reset: true,
  turnId: true,
  dispatchType: true,
  textLength: true,
  originalTextLength: true,
  imageCount: true,
  modelSelectionPresent: true,
  agentInvoked: true,
  failureStage: true,
  executionKind: true,
  criterion: true,
  statePresent: true,
  valid: true,
  itemCount: true,
  queueRemaining: true,
  delayMs: true,
  streaming: true,
  seqAtAbort: true,
  inputAcceptedSeq: true,
  disposed: true,
  seqAtRequest: true,
  exitCode: true,
  providerChanged: true,
  modelChanged: true,
  enabled: true,
  thoughtPresent: true,
  interactionDisposalStage: true,
  binary: true,
  executable: true,
  queryId: true,
  reasonCode: true,
  kind: true,
  resultStatus: true,
  windowCount: true,
  viewId: true,
  eventType: true,
  hasSessionFile: true,
  hasStore: true,
  eligibleFailure: true,
  snapshotCount: true,
  changedCount: true,
  forceClose: true,
  descriptorCount: true,
  protocolCode: true,
  directorySessionId: true,
  requestSent: true,
  ownerSessionId: true,
  canonicalId: true,
  winnerSessionId: true,
  aliasId: true,
  aliasKind: true,
  reuseStage: true,
  lookupMethod: true,
  reusedOwner: true,
  sessionPathPresent: true,
  childSubagentCount: true,
  commandOutputCount: true,
  rowCount: true,
  outcome: true,
  identityCount: true,
  recordId: true,
  recordCount: true,
  revision: true,
  currentRevision: true,
  offset: true,
  limit: true,
  pageEventCount: true,
  totalEventCount: true,
  hasNextPage: true,
  coverageStatus: true,
  coverageIssues: true,
  validSnapshotCount: true,
  rejectedSnapshotCount: true,
  rejectedCount: true,
  schemaIssueCount: true,
  requiredFieldRejectedCount: true,
  fallbackStatus: true,
  fallbackCount: true,
  configOptionCount: true,
  slashCommandCount: true,
  containerType: true,
  terminalResponsePossible: true,
  contextWindow: true,
  issues: true,
  cursorPresent: true,
  engineReused: true,
  cacheHit: true,
  readMode: true,
  versionChanged: true,
  readAttempted: true,
  fileCacheCount: true,
  processRevision: true,
  previousProcessPresent: true,
  processPresent: true,
  agentCount: true,
  historySourceCount: true,
  liveSourceCount: true,
  result: true,
};

// 只接纳共享交互 coverage schema 的固定 code；任意字符串数组仍不能经 Host 转发。
const safeCoverageIssues: Record<string, true> = {
  legacy_history_gaps: true,
  record_unavailable: true,
  missing_timestamp: true,
  ambiguous_identity: true,
  read_budget_exceeded: true,
};

export function redactOmpDiagnosticText(value: string, maxChars = MAX_TEXT_CHARS): string {
  const redacted = redactFeedbackText(value, { diagnostic: true });
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}[truncated]` : redacted;
}

export function sanitizeOmpDiagnosticFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(safeFields, key)) continue;
    if (++count > MAX_FIELDS) {
      result.truncated = true;
      break;
    }
    if (typeof value === "string") {
      const safe = redactOmpDiagnosticText(value);
      result[key] = safe;
      if (safe.endsWith("[truncated]")) result.truncated = true;
    } else if (typeof value === "boolean" || value === null) {
      result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (key === "supportedProtocolVersions" && Array.isArray(value)) {
      if (value.every((version) => Number.isSafeInteger(version) && version >= 0)) {
        result[key] = value.slice(0, 16);
        if (value.length > 16) result.truncated = true;
      }
    } else if (key === "coverageIssues" && Array.isArray(value)) {
      if (
        value.every(
          (issue) => typeof issue === "string" && Object.hasOwn(safeCoverageIssues, issue),
        )
      ) {
        result[key] = value.slice(0, 16);
        if (value.length > 16) result.truncated = true;
      }
    }
  }
  return result;
}

function validTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
  }
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** 返回 true 表示已识别（含按阈值过滤的记录），不能再写入退出 tail。 */
export function forwardOmpAgentDiagnostic(line: string, host: OmpDiagnosticHostContext): boolean {
  if (line.length > MAX_INPUT_CHARS || !line.trimStart().startsWith("{")) return false;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    record = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  const { ts, level, scope, message, pid, event } = record;
  if (
    scope !== "omp-agent" ||
    !validTimestamp(ts) ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 2_147_483_647 ||
    (level !== "info" && level !== "warn" && level !== "error" && level !== "debug") ||
    typeof message !== "string" ||
    !message.trim() ||
    (event !== undefined && (typeof event !== "string" || !safeEvent.test(event)))
  )
    return false;
  if (!isApplicationLogLevelEnabled(level)) return true;
  const safeMessage = redactOmpDiagnosticText(message);
  const fields = sanitizeOmpDiagnosticFields(record);
  // 闭包携带 spawn 时的事实，旧 runtime 的迟到 stderr 也不会串入新 runtime。
  for (const key of [
    "workspaceKey",
    "workspaceIdentity",
    "workspacePath",
    "runtimeGeneration",
    "runtimeInstanceId",
    "agentPid",
  ]) {
    delete fields[key];
  }
  const envelope = {
    ...fields,
    ...sanitizeOmpDiagnosticFields({ ...host, workspaceIdentity: host.workspaceIdentity ?? null }),
    ts,
    level,
    scope,
    pid,
    event: event ?? "omp_agent_message",
    message: safeMessage,
    ...(safeMessage.endsWith("[truncated]") ? { truncated: true } : {}),
  };
  try {
    agentLogger[level](undefined, JSON.stringify(envelope));
  } catch {
    // 诊断 sink 失败不得改变 stderr drain、协议或生命周期行为。
    reportDiagnosticSinkFailure();
  }
  return true;
}

export function writeOmpHostDiagnostic(
  level: OmpDiagnosticLevel,
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!isApplicationLogLevelEnabled(level)) return;
  try {
    hostLogger[level](
      undefined,
      JSON.stringify({
        ...sanitizeOmpDiagnosticFields(fields),
        ts: Date.now(),
        level,
        scope: "omp-host",
        pid: process.pid,
        event,
        message: event,
      }),
    );
  } catch {
    // 日志出口只观察，绝不替换业务结果或异常。
    reportDiagnosticSinkFailure();
  }
}

export function summarizeOmpDiagnosticResult(result: unknown): Record<string, unknown> {
  try {
    return {
      resultType: result === null ? "null" : Array.isArray(result) ? "array" : typeof result,
      ...(typeof result === "string" ? { resultLength: result.length } : {}),
      ...(Array.isArray(result) ? { resultCount: result.length } : {}),
      ...(result && typeof result === "object" && !Array.isArray(result)
        ? { resultFieldCount: Object.keys(result).length }
        : {}),
    };
  } catch {
    // 内存 transport 也可返回自定义对象；摘要失败不能冒充响应解码失败。
    return { resultType: "unknown" };
  }
}
