import type { OfflineDataBackupSnapshot } from "@zcode/shared";

export type OfflineDataBackupLifecycleState = Readonly<
  Omit<OfflineDataBackupSnapshot, "offline" | "activeProfile" | "runtimeRoot" | "persistentRoot">
>;

export const OFFLINE_DATA_BACKUP_PERIOD_MS = 600_000;

export interface OfflineDataBackupDiagnostic {
  phase: "started" | "completed" | "busy" | "failed";
  at: string;
  lastSuccessfulAt?: string;
  code?: string;
}

/** Main owns one delayed schedule and one admitted round, regardless of renderer/window count. */
export function createOfflineDataBackupLifecycle(options: {
  run(signal: AbortSignal): Promise<"completed" | "busy">;
  warn(): void;
  diagnostic?(event: OfflineDataBackupDiagnostic): void;
  onStateChanged?(state: OfflineDataBackupLifecycleState): void;
  now?: () => Date;
  schedule?: (callback: () => void, periodMs: number) => () => void;
}): {
  getState(): OfflineDataBackupLifecycleState;
  rendererReady(): void;
  stop(): void;
} {
  let cancelSchedule: (() => void) | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let warned = false;
  let state: OfflineDataBackupLifecycleState = Object.freeze({
    revision: 0,
    phase: "waiting",
    periodMs: OFFLINE_DATA_BACKUP_PERIOD_MS,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextScheduledAt: null,
    code: null,
  });
  const now = () => options.now?.() ?? new Date();
  const commit = (patch: Partial<Omit<OfflineDataBackupLifecycleState, "revision">>) => {
    state = Object.freeze({ ...state, ...patch, revision: state.revision + 1 });
    // 先提交再同步通知：订阅方在回调中读取时必须看到同一版，不能等备份异步启动后再补。
    options.onStateChanged?.(state);
  };
  const tick = () => {
    if (stopped) return;
    const at = now();
    const scheduledAt = Date.parse(state.nextScheduledAt!);
    // 下一时刻沿既有 interval 的固定周期前进；慢轮次和延迟 tick 都不按完成时间重置。
    const nextScheduledAt = new Date(
      scheduledAt +
        Math.max(1, Math.floor((at.getTime() - scheduledAt) / OFFLINE_DATA_BACKUP_PERIOD_MS) + 1) *
          OFFLINE_DATA_BACKUP_PERIOD_MS,
    ).toISOString();
    if (controller) {
      commit({ nextScheduledAt });
      return;
    }
    const round = new AbortController();
    controller = round;
    commit({
      phase: "running",
      lastAttemptAt: at.toISOString(),
      nextScheduledAt,
      code: null,
    });
    void Promise.resolve()
      .then(() => {
        if (round.signal.aborted) return;
        options.diagnostic?.({
          phase: "started",
          at: state.lastAttemptAt!,
          lastSuccessfulAt: state.lastSuccessfulAt ?? undefined,
        });
        return options.run(round.signal);
      })
      .then((status) => {
        if (stopped || round.signal.aborted || status === undefined) return;
        const at = now().toISOString();
        if (status === "completed") warned = false;
        commit({
          phase: status,
          ...(status === "completed" ? { lastSuccessfulAt: at } : {}),
          code: null,
        });
        options.diagnostic?.({
          phase: status,
          at,
          lastSuccessfulAt: state.lastSuccessfulAt ?? undefined,
        });
      })
      .catch((error: unknown) => {
        if (stopped || round.signal.aborted) return;
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? error.code
            : "BACKUP_FAILED";
        const at = now().toISOString();
        commit({ phase: "failed", code });
        options.diagnostic?.({
          phase: "failed",
          at,
          lastSuccessfulAt: state.lastSuccessfulAt ?? undefined,
          code,
        });
        if (!warned) {
          warned = true;
          options.warn();
        }
      })
      .finally(() => {
        if (controller === round) controller = undefined;
      });
  };
  return {
    getState: () => state,
    rendererReady() {
      if (stopped || state.nextScheduledAt !== null) return;
      const schedule =
        options.schedule ??
        ((callback, periodMs) => {
          const timer = setInterval(callback, periodMs);
          timer.unref?.();
          return () => clearInterval(timer);
        });
      commit({
        nextScheduledAt: new Date(now().getTime() + OFFLINE_DATA_BACKUP_PERIOD_MS).toISOString(),
      });
      if (stopped) return;
      cancelSchedule = schedule(tick, OFFLINE_DATA_BACKUP_PERIOD_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelSchedule?.();
      cancelSchedule = undefined;
      controller?.abort();
      commit({ nextScheduledAt: null });
    },
  };
}
