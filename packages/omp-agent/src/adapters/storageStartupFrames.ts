// 存储启动帧：app-server 正常路径发 startup/storageState（omp 核无 CLI SQLite 库，直接 ready）；
// --prepare-storage worker 路径按 CLI 帧序（storagePath → 等待 ack → storagePrepared）无操作完成。

import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import { createId } from "../domain/ids.js";
import { logger } from "./logger.js";

const ACK_TIMEOUT_MS = 30_000;

/** app-server 启动时发射 storageState（checking → ready）。 */
export function emitStorageStartup(output: NodeJS.WritableStream): void {
  const attemptId = createId("storage");
  const base = {
    schemaVersion: 1 as const,
    attemptId,
    databaseId: "omp-agent",
    databaseKind: "session" as const,
    elapsedMs: 0,
  };
  output.write(
    encodeJsonlLine({
      method: "startup/storageState",
      params: { ...base, sequence: 1, phase: "checking" },
    }),
  );
  output.write(
    encodeJsonlLine({
      method: "startup/storageState",
      params: { ...base, sequence: 2, phase: "ready", completed: 1, total: 1 },
    }),
  );
}

/**
 * --prepare-storage worker：会话存储由 omp 自有数据目录承担，无需 SQLite 迁移；
 * 但必须按 host 的帧契约完成握手（storagePath → storagePathReady ack → storagePrepared，exit 0）。
 */
export async function runPrepareStorageWorker(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  storagePath: string;
}): Promise<void> {
  const { createInterface } = await import("node:readline");
  const path = options.storagePath;
  options.output.write(encodeJsonlLine({ method: "startup/storagePath", params: { path } }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup_status_timeout")), ACK_TIMEOUT_MS);
    timer.unref?.();
    const readline = createInterface({ input: options.input });
    const onLine = (line: string): void => {
      try {
        const message = JSON.parse(line.trim());
        if (typeof message === "object" && message !== null && (message as { method?: unknown }).method === "startup/storagePathReady") {
          readline.removeListener("line", onLine);
          clearTimeout(timer);
          resolve();
        }
      } catch {
        // 非 JSON 行忽略（worker stdin 只有 host 控制帧）。
      }
    };
    readline.on("line", onLine);
    readline.once("close", () => {
      clearTimeout(timer);
      reject(new Error("transport_closed"));
    });
  });
  options.output.write(
    encodeJsonlLine({
      method: "startup/storageState",
      params: {
        schemaVersion: 1,
        attemptId: createId("prep"),
        sequence: 1,
        databaseId: "omp-agent",
        databaseKind: "session",
        phase: "ready",
        elapsedMs: 0,
      },
    }),
  );
  options.output.write(encodeJsonlLine({ method: "startup/storagePrepared", params: {} }));
  logger.info("prepare-storage worker 完成（omp 核无 SQLite 会话库）", { path });
}
