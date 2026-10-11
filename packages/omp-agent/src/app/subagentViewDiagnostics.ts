// 详情读取原有 catch 会保留投影；在回退前记录阶段，避免静默空视图且不记录模型/工具正文。
import { parseOmpSubagentViewId } from "../domain/ompFrames.js";
import { readPersistedSubagentEntries } from "./coldHydration.js";
import { diagnostics } from "./diagnostics.js";
import type { OmpStorePort } from "./ports.js";
import { readSubagentRecord, type EngineSubagentHost } from "./subagentControl.js";

interface ReadSummary {
  nextByte: number;
  entries: unknown[];
}

function counts(state: ReadSummary): Record<string, unknown> {
  return { fromByte: state.nextByte, entryCount: state.entries.length };
}

function parentFailed(parentSessionId: string, error: unknown): null {
  diagnostics.warn("omp.subagent.view.failed", {
    sessionId: parentSessionId,
    parentSessionId,
    stage: "parent_resume",
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return null;
}

function unavailable(viewId: string, stage: string, state: ReadSummary): "unavailable" {
  result(viewId, stage, { resultStatus: "unavailable", ...counts(state) });
  return "unavailable";
}

function invalidRecord(viewId: string, state: ReadSummary): void {
  failed(viewId, "record_decode", undefined, counts(state));
}

function window(
  viewId: string,
  state: ReadSummary,
  record: { entries?: unknown; nextByte?: unknown; reset?: unknown },
): void {
  result(viewId, "record_window", {
    fromByte: state.nextByte,
    nextByte: typeof record.nextByte === "number" ? record.nextByte : undefined,
    entryCount: Array.isArray(record.entries) ? record.entries.length : 0,
    reset: record.reset === true,
  });
}

function capped(viewId: string, state: ReadSummary, windowCount: number): "capped" {
  result(viewId, "read_budget", { resultStatus: "capped", ...counts(state), windowCount });
  return "capped";
}

function readRecord(
  viewId: string,
  host: EngineSubagentHost,
  subagentId: string,
  fromByte: number,
) {
  return observe(viewId, "read_record", () => readSubagentRecord(host, subagentId, fromByte));
}

function identity(viewId: string): Record<string, unknown> {
  const parsed = parseOmpSubagentViewId(viewId);
  return {
    viewId,
    sessionId: parsed?.parentSessionId,
    parentSessionId: parsed?.parentSessionId,
    subagentId: parsed?.subagentId,
  };
}

function failed(
  viewId: string,
  stage: string,
  error?: unknown,
  fields?: Record<string, unknown>,
): void {
  diagnostics.warn("omp.subagent.view.failed", {
    ...identity(viewId),
    stage,
    errorType: error instanceof Error ? error.name : typeof error,
    ...fields,
  });
}

function result(viewId: string, stage: string, fields: Record<string, unknown>): void {
  const details = { ...identity(viewId), stage, ...fields };
  if (fields.resultStatus === "capped" || fields.resultStatus === "unavailable")
    diagnostics.warn("omp.subagent.view.read.result", details);
  else diagnostics.debug("omp.subagent.view.read.result", details);
}

async function observe<T>(viewId: string, stage: string, callback: () => Promise<T>): Promise<T> {
  return diagnostics.run(identity(viewId), async () => {
    const startedAt = Date.now();
    diagnostics.debug("omp.subagent.view.read.started", { stage });
    try {
      const value = await callback();
      diagnostics.debug("omp.subagent.view.read.completed", {
        stage,
        elapsedMs: Date.now() - startedAt,
      });
      return value;
    } catch (error) {
      failed(viewId, stage, error, { elapsedMs: Date.now() - startedAt });
      throw error;
    }
  });
}

async function fallback(
  viewId: string,
  sessionFile: string | null,
  store: Pick<OmpStorePort, "readSessionEntries" | "readSubagentEntries"> | undefined,
  subagentId: string,
  error: string | undefined,
  fromByte: number,
): Promise<unknown[] | null> {
  return diagnostics.run(identity(viewId), async () => {
    const startedAt = Date.now();
    const fields = {
      ...identity(viewId),
      stage: "persisted_fallback",
      fromByte,
      hasSessionFile: sessionFile !== null,
      hasStore: store !== undefined,
      eligibleFailure: error?.startsWith("Unknown subagent or session file unavailable:") === true,
    };
    diagnostics.warn("omp.subagent.view.fallback.started", fields);
    try {
      const entries = await readPersistedSubagentEntries(sessionFile, store, subagentId, error);
      diagnostics.warn("omp.subagent.view.fallback.result", {
        ...fields,
        resultStatus: entries === null ? "unavailable" : entries.length === 0 ? "empty" : "read",
        entryCount: entries?.length ?? 0,
        elapsedMs: Date.now() - startedAt,
      });
      return entries;
    } catch (failure) {
      failed(viewId, "persisted_fallback", failure, {
        fromByte,
        elapsedMs: Date.now() - startedAt,
      });
      throw failure;
    }
  });
}

function project<T>(viewId: string, state: ReadSummary, callback: () => T): T {
  const startedAt = Date.now();
  try {
    return callback();
  } catch (error) {
    failed(viewId, "projection_rows", error, {
      ...counts(state),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export const subagentViewDiagnostics = {
  failed,
  result,
  fallback,
  project,
  parentFailed,
  unavailable,
  invalidRecord,
  window,
  capped,
  readRecord,
};
