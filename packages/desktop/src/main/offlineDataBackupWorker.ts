import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runOfflineDataBackup } from "@zcode/services/node";
import type {
  OfflineDataBackupWorkerData,
  OfflineDataBackupWorkerMessage,
} from "./offlineDataBackupWorkerProtocol.js";

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as OfflineDataBackupWorkerData;
  const controller = new AbortController();
  port.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "abort") {
      controller.abort();
    }
  });
  const post = (message: OfflineDataBackupWorkerMessage) => port.postMessage(message);
  void runOfflineDataBackup(data.roots, {
    logicalFiles: data.logicalFiles,
    signal: controller.signal,
  })
    .then((result) => post({ type: "done", status: result.status }))
    // Never send paths, stored content or raw remote filesystem messages into Main/renderer logs.
    .catch((error: unknown) => {
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "BACKUP_FAILED";
      post({ type: "error", code });
    })
    .finally(() => port.close());
}
