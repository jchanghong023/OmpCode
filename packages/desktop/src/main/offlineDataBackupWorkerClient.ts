import { Worker } from "node:worker_threads";
import { releaseOfflineDataBackupLease } from "@zcode/services/node";
import type { OfflineDataBackupWorkerData } from "./offlineDataBackupWorkerProtocol.js";

export interface OfflineBackupWorkerHandle {
  threadId: number;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref(): void;
}

/** Resolves only after thread exit + local owned-lease cleanup, never while another round can overlap. */
export function runOfflineDataBackupWorker(
  data: OfflineDataBackupWorkerData,
  signal: AbortSignal,
  options: {
    createWorker?: (data: OfflineDataBackupWorkerData) => OfflineBackupWorkerHandle;
    releaseLease?: typeof releaseOfflineDataBackupLease;
  } = {},
): Promise<"completed" | "busy"> {
  if (signal.aborted) return Promise.reject(new Error("offline_backup_aborted"));
  return new Promise<"completed" | "busy">((resolve, reject) => {
    const worker: OfflineBackupWorkerHandle =
      options.createWorker?.(data) ??
      new Worker(new URL("./offlineDataBackupWorker.js", import.meta.url), { workerData: data });
    const owner = { pid: process.pid, threadId: worker.threadId };
    let status: "completed" | "busy" | undefined;
    let failure: Error | undefined;
    const onAbort = () => {
      failure = new Error("offline_backup_aborted");
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        /* Already exiting. */
      }
      // Quit never waits for a remote filesystem call or a cooperative abort.
      void worker.terminate().catch(() => {});
    };
    worker.on("message", (message) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (
        message.type === "done" &&
        "status" in message &&
        (message.status === "completed" || message.status === "busy")
      )
        status = message.status;
      else if (message.type === "error") {
        const code =
          "code" in message &&
          typeof message.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(message.code)
            ? message.code
            : "BACKUP_FAILED";
        failure = Object.assign(new Error("offline_backup_failed"), { code });
      }
    });
    worker.once("error", () => {
      failure = new Error("offline_backup_worker_failed");
    });
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      void (options.releaseLease ?? releaseOfflineDataBackupLease)(data.roots, owner).then(
        () => {
          if (failure) reject(failure);
          else if (code !== 0 || !status) reject(new Error("offline_backup_worker_exited"));
          else resolve(status);
        },
        () => reject(new Error("offline_backup_lease_cleanup_failed")),
      );
    });
    signal.addEventListener("abort", onAbort, { once: true });
    worker.unref();
    if (signal.aborted) onAbort();
  });
}
