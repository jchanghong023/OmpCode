const diagnosticTimestamp =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})?$/u;
const serviceDiagnosticPrefix =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[pid:\d+\] \[(omp-agent|omp-host)\] (\{[\s\S]*\})$/u;

/** 文件轮转仍以 Main 本地日期为准，与统一 UTC ISO 的物理前缀无关。 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeDiagnosticTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (
    typeof value === "number"
      ? !Number.isSafeInteger(value) || value <= 0
      : !diagnosticTimestamp.test(value)
  )
    return undefined;
  // 旧的无时区 ServiceLogger 时间按本地时间解释；新前缀一律输出毫秒 UTC ISO。
  const date = new Date(typeof value === "string" ? value.replace(" ", "T") : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isOmpDiagnosticRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.scope === "omp-agent" || record.scope === "omp-host") &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    record.pid <= 2_147_483_647 &&
    normalizeDiagnosticTimestamp(record.ts) !== undefined &&
    (record.level === "debug" ||
      record.level === "info" ||
      record.level === "warn" ||
      record.level === "error") &&
    typeof record.message === "string" &&
    record.message.trim().length > 0 &&
    (record.event === undefined ||
      (typeof record.event === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/u.test(record.event)))
  );
}

/** 只解包已知 ServiceLogger 边界或完整 JSON，不从任意正文搜索 JSON 片段。 */
export function parseOmpDiagnosticMessage(message: string): Record<string, unknown> | undefined {
  const text = message.trim();
  const prefix = serviceDiagnosticPrefix.exec(text);
  const json = prefix ? prefix[2]! : text;
  if (!json.startsWith("{")) return undefined;
  try {
    const record: unknown = JSON.parse(json);
    if (!isOmpDiagnosticRecord(record) || (prefix && record.scope !== prefix[1])) return undefined;
    return record;
  } catch {
    // 普通 ServiceLogger 文本和不合法 JSON 沿用文本转发，不制造解析失败日志。
    return undefined;
  }
}

export function mainLogContext(args: unknown[], source: string, now: Date, mainPid: number) {
  const first = args[0];
  // Host 已解析的 omp JSON 保留原始来源身份；Main PID 不能冒充适配器 PID。
  const diagnostic =
    args.length === 1 &&
    first &&
    typeof first === "object" &&
    "scope" in first &&
    (first.scope === "omp-agent" || first.scope === "omp-host")
      ? (first as Record<string, unknown>)
      : undefined;
  return {
    source: diagnostic ? String(diagnostic.scope) : source,
    pid: diagnostic ? (typeof diagnostic.pid === "number" ? diagnostic.pid : "unknown") : mainPid,
    timestamp: (diagnostic && normalizeDiagnosticTimestamp(diagnostic.ts)) || now.toISOString(),
  };
}
