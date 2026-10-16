import type { OfflineDataRoots } from "@zcode/shared/node";

export interface OfflineDataBackupWorkerData {
  roots: OfflineDataRoots;
  logicalFiles: ReadonlyArray<{ relativePath: string; content: string }>;
}
export type OfflineDataBackupWorkerMessage =
  | { type: "done"; status: "completed" | "busy" }
  | { type: "error"; code: string };
