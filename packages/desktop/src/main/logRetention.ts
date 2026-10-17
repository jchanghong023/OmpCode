import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { maybeThrowInjectedFsFault } from "@zcode/services/node";

export const LOG_RETENTION_DAYS = 14;
const LOG_MAX_FILE_BYTES = 1_048_576;
const LOG_MAX_FILE_COUNT = 10;

const LOG_RUN_ID_PATTERN =
  "\\d{13}-[1-9]\\d*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OWNED_LOG_FILE_NAME_RE = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})(?:\\.(${LOG_RUN_ID_PATTERN}))?(?:\\.([1-9]\\d*))?\\.log$`,
);

interface OwnedLogFile {
  name: string;
  date: Date;
  runId: string;
  historyIndex: number | null;
}

interface LogFileInfo {
  size: number;
}

interface LogRetentionCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
}

export class LogRetentionError extends Error {
  readonly failedFiles: readonly string[];

  constructor(failedFiles: readonly string[]) {
    super(`Could not enforce log retention: ${failedFiles.join(", ")}`);
    this.name = "LogRetentionError";
    this.failedFiles = failedFiles;
  }
}

function parseLogDate(yearText: string, monthText: string, dayText: string): Date | null {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parsed = new Date(0);
  parsed.setFullYear(year, month - 1, day);
  parsed.setHours(0, 0, 0, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function parseOwnedLogFileName(fileName: string): OwnedLogFile | null {
  const match = OWNED_LOG_FILE_NAME_RE.exec(fileName);
  if (!match) return null;
  const date = parseLogDate(match[1]!, match[2]!, match[3]!);
  const historyIndex = match[5] === undefined ? null : Number(match[5]);
  if (!date || (historyIndex !== null && !Number.isSafeInteger(historyIndex))) return null;
  return { name: fileName, date, runId: match[4] ?? "", historyIndex };
}

function getStartOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getLogRetentionCutoffDate(now: Date, retentionDays: number): Date {
  const cutoff = getStartOfLocalDay(now);
  cutoff.setDate(cutoff.getDate() - Math.max(retentionDays - 1, 0));
  return cutoff;
}

function compareOldestFirst(left: OwnedLogFile, right: OwnedLogFile): number {
  const dateDifference = left.date.getTime() - right.date.getTime();
  if (dateDifference !== 0) return dateDifference;
  const runDifference = left.runId.localeCompare(right.runId);
  if (runDifference !== 0) return runDifference;
  const leftIndex = left.historyIndex ?? Number.POSITIVE_INFINITY;
  const rightIndex = right.historyIndex ?? Number.POSITIVE_INFINITY;
  return leftIndex - rightIndex || left.name.localeCompare(right.name);
}

export async function cleanupExpiredLogFiles(
  logDir: string,
  options?: {
    now?: Date;
    retentionDays?: number;
    activeFileName?: string;
    reserveActiveFile?: boolean;
  },
): Promise<LogRetentionCleanupResult> {
  const now = options?.now ?? new Date();
  const retentionDays = options?.retentionDays ?? LOG_RETENTION_DAYS;
  const activeFileName = options?.activeFileName;
  const protectedNames = new Set(activeFileName ? [activeFileName] : []);
  const maxFiles = LOG_MAX_FILE_COUNT - (options?.reserveActiveFile ? 1 : 0);

  try {
    maybeThrowInjectedFsFault({ operation: "readdir", path: logDir });
    const entries = await readdir(logDir, { withFileTypes: true });
    const ownedFiles: OwnedLogFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ownedFile = parseOwnedLogFileName(entry.name);
      if (ownedFile) ownedFiles.push(ownedFile);
    }

    const deletedFiles: string[] = [];
    const failedFiles: string[] = [];
    const failedNames = new Set<string>();
    const deletedNames = new Set<string>();
    const recordFailure = (name: string) => {
      if (failedNames.has(name)) return;
      failedNames.add(name);
      failedFiles.push(name);
    };
    const deleteFile = async (file: OwnedLogFile): Promise<boolean> => {
      try {
        const filePath = join(logDir, file.name);
        maybeThrowInjectedFsFault({ operation: "rm", path: filePath });
        await unlink(filePath);
        deletedFiles.push(file.name);
        deletedNames.add(file.name);
        return true;
      } catch {
        recordFailure(file.name);
        return false;
      }
    };

    const cutoff = getLogRetentionCutoffDate(now, retentionDays);
    let ownedFileCount = ownedFiles.length;
    for (const file of ownedFiles) {
      if (protectedNames.has(file.name) || file.date >= cutoff) continue;
      if (await deleteFile(file)) ownedFileCount -= 1;
    }

    ownedFiles.sort(compareOldestFirst);
    for (const file of ownedFiles) {
      if (ownedFileCount <= maxFiles) break;
      if (
        protectedNames.has(file.name) ||
        failedNames.has(file.name) ||
        deletedNames.has(file.name)
      )
        continue;
      if (await deleteFile(file)) ownedFileCount -= 1;
    }
    if (ownedFileCount > maxFiles) recordFailure("<capacity>");

    return { deletedFiles, failedFiles };
  } catch {
    return { deletedFiles: [], failedFiles: ["<directory>"] };
  }
}

async function readLogFileInfo(filePath: string): Promise<LogFileInfo | null> {
  try {
    maybeThrowInjectedFsFault({ operation: "stat", path: filePath });
    const info = await lstat(filePath);
    if (!info.isFile()) throw new Error("Active log path is not an ordinary file");
    return { size: info.size };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function getNextHistoryPath(logDir: string, fileStem: string): Promise<string> {
  if (!parseOwnedLogFileName(`${fileStem}.log`)) throw new Error("Invalid active log name");
  maybeThrowInjectedFsFault({ operation: "readdir", path: logDir });
  const entries = await readdir(logDir, { withFileTypes: true });
  const occupiedNames = new Set<string>();
  let maxHistoryIndex = 0;
  for (const entry of entries) {
    occupiedNames.add(entry.name);
    const ownedFile = parseOwnedLogFileName(entry.name);
    if (ownedFile?.name.startsWith(`${fileStem}.`) && ownedFile.historyIndex !== null) {
      maxHistoryIndex = Math.max(maxHistoryIndex, ownedFile.historyIndex);
    }
  }

  let historyIndex = maxHistoryIndex + 1;
  while (Number.isSafeInteger(historyIndex) && occupiedNames.has(`${fileStem}.${historyIndex}.log`))
    historyIndex += 1;
  if (!Number.isSafeInteger(historyIndex))
    throw new Error("No safe log history index is available");
  return join(logDir, `${fileStem}.${historyIndex}.log`);
}

async function rotateActiveLogFile(
  logDir: string,
  fileStem: string,
  renameFile: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  const activePath = join(logDir, `${fileStem}.log`);
  const activeInfo = await readLogFileInfo(activePath);
  if (!activeInfo) return;
  const historyPath = await getNextHistoryPath(logDir, fileStem);
  await renameFile(activePath, historyPath);
}

export async function prepareLogFile(
  logDir: string,
  fileStem: string,
  appendFile: (filePath: string, text: string) => Promise<void>,
  renameFile: (source: string, destination: string) => Promise<void>,
  retainFiles: (reserveActiveFile: boolean) => Promise<void>,
): Promise<void> {
  if (!parseOwnedLogFileName(`${fileStem}.log`)) throw new Error("Invalid active log name");
  const activePath = join(logDir, `${fileStem}.log`);
  const activeInfo = await readLogFileInfo(activePath);
  const needsRotation = activeInfo !== null && activeInfo.size > LOG_MAX_FILE_BYTES;
  await retainFiles(activeInfo === null || needsRotation);
  if (needsRotation) await rotateActiveLogFile(logDir, fileStem, renameFile);
  await appendFile(activePath, "");
}

export async function appendLogRecords(
  logDir: string,
  fileStem: string,
  records: readonly { line: string; bytes: number }[],
  appendFile: (filePath: string, text: string) => Promise<void>,
  renameFile: (source: string, destination: string) => Promise<void>,
  retainFiles: (reserveActiveFile: boolean) => Promise<void>,
): Promise<void> {
  if (records.length === 0) return;
  if (!parseOwnedLogFileName(`${fileStem}.log`)) throw new Error("Invalid active log name");
  const activePath = join(logDir, `${fileStem}.log`);
  const activeInfo = await readLogFileInfo(activePath);
  await retainFiles(activeInfo === null || activeInfo.size > LOG_MAX_FILE_BYTES);
  let activeBytes = activeInfo?.size ?? 0;
  const chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async () => {
    if (chunk.length === 0) return;
    await appendFile(activePath, chunk.join(""));
    activeBytes += chunkBytes;
    chunk.length = 0;
    chunkBytes = 0;
  };

  for (const record of records) {
    if (
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      record.bytes > LOG_MAX_FILE_BYTES
    )
      throw new Error("Log record exceeds the maximum file size");
    if (activeBytes + chunkBytes + record.bytes > LOG_MAX_FILE_BYTES) {
      await flushChunk();
      if (activeBytes > 0) {
        await retainFiles(true);
        await rotateActiveLogFile(logDir, fileStem, renameFile);
        activeBytes = 0;
      }
    }
    if (activeBytes + record.bytes > LOG_MAX_FILE_BYTES)
      throw new Error("Log record exceeds the maximum file size");
    chunk.push(record.line);
    chunkBytes += record.bytes;
  }
  await flushChunk();
}
