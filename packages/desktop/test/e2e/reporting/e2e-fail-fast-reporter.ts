import { EventEmitter } from "node:events";

export interface E2EFailureNotification {
  kind: "test" | "hook" | "runner" | "prepare";
  title: string;
  error: unknown;
  cid?: string;
}

let failureReported = false;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error ?? "E2E failed without an error message");
}

/** Notify the owning invocation before any asynchronous diagnostics or teardown. */
export function notifyE2EFailure(failure: E2EFailureNotification): boolean {
  const prefix = process.env.ZCODE_E2E_FAIL_FAST_PREFIX;
  if (!prefix || failureReported) {
    return false;
  }
  failureReported = true;
  process.stdout.write(
    prefix +
      JSON.stringify({
        kind: failure.kind,
        title: failure.title.slice(0, 1024),
        error: errorMessage(failure.error).slice(0, 8192),
        ...(failure.cid ? { cid: failure.cid.slice(0, 128) } : {}),
      }) +
      "\n",
  );
  return true;
}

export function hasReportedE2EFailure(): boolean {
  return failureReported;
}

interface FailureEvent {
  title?: string;
  fullTitle?: string;
  error?: unknown;
  errors?: unknown[];
  cid?: string;
  failures?: number;
}

// WDIO's ReporterInstance contract is EventEmitter + isSynchronised. No stats,
// file streams or asynchronous reporter synchronization are needed for this signal.
export default class E2EFailFastReporter extends EventEmitter {
  readonly isSynchronised = true;
  private cid?: string;

  constructor(_options: object = {}) {
    super();
    this.on("runner:start", (event: FailureEvent) => {
      this.cid = event.cid;
      if (event.error) this.report("runner", event);
    });
    this.on("test:fail", (event: FailureEvent) => this.report("test", event));
    // Retries are disabled; an unexpected retry must not hide the original failure.
    this.on("test:retry", (event: FailureEvent) => this.report("test", event));
    this.on("hook:end", (event: FailureEvent) => {
      if (event.error || event.errors?.length) this.report("hook", event);
    });
    this.on("runner:error", (event: FailureEvent) => this.report("runner", event));
    this.on("runner:end", (event: FailureEvent) => {
      if (event.error || event.errors?.length || (event.failures ?? 0) > 0) {
        this.report("runner", event);
      }
    });
  }

  private report(kind: E2EFailureNotification["kind"], event: FailureEvent): void {
    notifyE2EFailure({
      kind,
      title: event.fullTitle || event.title || `${kind} failure`,
      error: event.error ?? event.errors?.[0] ?? "E2E runner reported failures",
      cid: event.cid ?? this.cid,
    });
  }
}
