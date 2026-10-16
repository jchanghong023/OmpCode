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
  now?: () => Date;
  schedule?: (callback: () => void, periodMs: number) => () => void;
}): { rendererReady(): void; stop(): void } {
  let cancelSchedule: (() => void) | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let warned = false;
  let lastSuccessfulAt: string | undefined;
  const tick = () => {
    if (stopped || controller) return;
    const round = new AbortController();
    controller = round;
    void Promise.resolve()
      .then(() => {
        if (round.signal.aborted) return;
        options.diagnostic?.({
          phase: "started",
          at: (options.now?.() ?? new Date()).toISOString(),
          lastSuccessfulAt,
        });
        return options.run(round.signal);
      })
      .then((status) => {
        if (stopped || round.signal.aborted || status === undefined) return;
        const at = (options.now?.() ?? new Date()).toISOString();
        if (status === "completed") {
          warned = false;
          lastSuccessfulAt = at;
        }
        options.diagnostic?.({ phase: status, at, lastSuccessfulAt });
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
        options.diagnostic?.({
          phase: "failed",
          at: (options.now?.() ?? new Date()).toISOString(),
          lastSuccessfulAt,
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
    rendererReady() {
      if (stopped || cancelSchedule) return;
      const schedule =
        options.schedule ??
        ((callback, periodMs) => {
          const timer = setInterval(callback, periodMs);
          timer.unref?.();
          return () => clearInterval(timer);
        });
      cancelSchedule = schedule(tick, OFFLINE_DATA_BACKUP_PERIOD_MS);
    },
    stop() {
      stopped = true;
      cancelSchedule?.();
      cancelSchedule = undefined;
      controller?.abort();
    },
  };
}
