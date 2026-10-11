import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { maybeThrowInjectedFsFault } from "@zcode/services/node";

export const LOG_RETENTION_DAYS = 14;
export const LOG_MAX_FILE_BYTES = 1_048_576;
export const LOG_MAX_FILE_COUNT = 10;

const ACTIVE_LOG_FILE_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
const HISTORY_LOG_FILE_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.([1-9]\d*)\.log$/;

interface OwnedLogFile {
  name: string;
  date: Date;
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
  const activeMatch = ACTIVE_LOG_FILE_NAME_RE.exec(fileName);
  if (activeMatch) {
    const date = parseLogDate(activeMatch[1]!, activeMatch[2]!, activeMatch[3]!);
    return date ? { name: fileName, date, historyIndex: null } : null;
  }

  const historyMatch = HISTORY_LOG_FILE_NAME_RE.exec(fileName);
  if (!historyMatch) return null;
  const date = parseLogDate(historyMatch[1]!, historyMatch[2]!, historyMatch[3]!);
  const historyIndex = Number(historyMatch[4]);
  if (!date || !Number.isSafeInteger(historyIndex)) return null;
  return { name: fileName, date, historyIndex };
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

async function getNextHistoryPath(logDir: string, date: string): Promise<string> {
  if (!parseOwnedLogFileName(`${date}.log`)) throw new Error("Invalid active log date");
  maybeThrowInjectedFsFault({ operation: "readdir", path: logDir });
  const entries = await readdir(logDir, { withFileTypes: true });
  const occupiedNames = new Set<string>();
  let maxHistoryIndex = 0;
  for (const entry of entries) {
    occupiedNames.add(entry.name);
    const ownedFile = parseOwnedLogFileName(entry.name);
    if (ownedFile?.name.startsWith(`${date}.`) && ownedFile.historyIndex !== null) {
      maxHistoryIndex = Math.max(maxHistoryIndex, ownedFile.historyIndex);
    }
  }

  let historyIndex = maxHistoryIndex + 1;
  while (Number.isSafeInteger(historyIndex) && occupiedNames.has(`${date}.${historyIndex}.log`))
    historyIndex += 1;
  if (!Number.isSafeInteger(historyIndex))
    throw new Error("No safe log history index is available");
  return join(logDir, `${date}.${historyIndex}.log`);
}

async function rotateActiveLogFile(
  logDir: string,
  date: string,
  renameFile: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  const activePath = join(logDir, `${date}.log`);
  const activeInfo = await readLogFileInfo(activePath);
  if (!activeInfo) return;
  const historyPath = await getNextHistoryPath(logDir, date);
  await renameFile(activePath, historyPath);
}

export async function prepareLogFile(
  logDir: string,
  date: string,
  appendFile: (filePath: string, text: string) => Promise<void>,
  renameFile: (source: string, destination: string) => Promise<void>,
  retainFiles: (reserveActiveFile: boolean) => Promise<void>,
): Promise<void> {
  if (!parseOwnedLogFileName(`${date}.log`)) throw new Error("Invalid active log date");
  const activePath = join(logDir, `${date}.log`);
  const activeInfo = await readLogFileInfo(activePath);
  const needsRotation = activeInfo !== null && activeInfo.size > LOG_MAX_FILE_BYTES;
  await retainFiles(activeInfo === null || needsRotation);
  if (needsRotation) await rotateActiveLogFile(logDir, date, renameFile);
  await appendFile(activePath, "");
}

export async function appendLogRecords(
  logDir: string,
  date: string,
  records: readonly { line: string; bytes: number }[],
  appendFile: (filePath: string, text: string) => Promise<void>,
  renameFile: (source: string, destination: string) => Promise<void>,
  retainFiles: (reserveActiveFile: boolean) => Promise<void>,
): Promise<void> {
  if (records.length === 0) return;
  if (!parseOwnedLogFileName(`${date}.log`)) throw new Error("Invalid active log date");
  const activePath = join(logDir, `${date}.log`);
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
        await rotateActiveLogFile(logDir, date, renameFile);
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
