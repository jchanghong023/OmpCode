import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { backupDatabase, createDatabaseSync } from "../session/tasksDatabase/sqlite.js";
import {
  assertRealPath,
  assertSQLiteSidecars,
  checkAbort,
  equalStamp,
  errorCode,
  hashFile,
  OfflineBackupError,
  openRegular,
  privateDirectory,
  sameIdentity,
  stamp,
  syncDirectory,
  syncFile,
  validRelativePath,
  writePrivate,
  type FileStamp,
} from "./backupFiles.js";
import { copyStable } from "./backupStableFile.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");

// 条目类型只在本模块使用；跨模块消费者统一通过 SnapshotManifest 读取快照结构。
interface SnapshotEntry {
  path: string;
  kind: "file" | "sqlite" | "directory" | "logical";
  mode: number;
  stamp?: FileStamp;
  sha256?: string;
  /** Known append-only Main log: only complete lines in its initial extent. */
  prefixBytes?: number;
}

export interface SnapshotManifest {
  format: 1;
  status: "complete";
  domainId: string;
  generation: string;
  completedAt: string;
  runtimeRoot: string;
  persistentRoot: string;
  runtimeIdentity: string;
  scope: "complete-runtime-only";
  consistency: "individual-sqlite-transactions-and-stable-files-not-global-transaction";
  recovery: string;
  deletionScope: "same-runtime-incarnation-only-never-original-persistent-root";
  deletedSincePrevious: string[];
  entries: SnapshotEntry[];
  excluded: Array<{ path: string; reason: string }>;
}

interface SnapshotOptions {
  runtimeRoot: string;
  dataRoot: string;
  scratchRoot: string;
  previousDataRoot?: string;
  previousEntries: SnapshotEntry[];
  logicalFiles: ReadonlyArray<{ relativePath: string; content: string }>;
  signal?: AbortSignal;
}

function exclusion(name: string, relative: string): string | undefined {
  if (name.startsWith(".offline-shm-")) return "backup-runtime";
  if (
    /^(?:cache|caches|code cache|gpucache|dawncache|shadercache|grshadercache|graphitedawncache|crashpad|crash reports|tmp|temp)$/i.test(
      name,
    )
  ) {
    return "rebuildable-cache-or-temporary";
  }
  if (
    /^(?:Singleton(?:Cookie|Lock|Socket)|lock|LOCK|CURRENT\.tmp)$/i.test(name) ||
    /(?:\.lock(?:\.\d+)?$|\.pid$|\.sock$|\.socket$|\.tmp(?:$|[-.])|\.temp$|\.swp$|~$)/i.test(name)
  ) {
    return "ephemeral";
  }
  // Chromium 的 DIPS/Cookies 等数据库可被引擎独占锁定；持久状态由逻辑导出负责。
  // 每个应用只保存自身的导出 sidecar，不把原始 profile 或缓存误当可恢复业务文件。
  if (/^electron\/[^/]+(?:\/|$)/i.test(relative) && name !== "first-party-browser-state.json") {
    return "browser-engine-state";
  }
  // Chromium's live LevelDB is not a file snapshot protocol. First-party state
  // comes from the caller's logicalFiles, not CURRENT/MANIFEST/log copying.
  if (
    /^electron(?:\/|$)/i.test(relative) &&
    /^(?:local storage|session storage|indexeddb|service worker|shared_proto_db|leveldb|databases|file system)$/i.test(
      name,
    )
  ) {
    return "browser-raw-storage";
  }
  if (/\.leveldb$/i.test(name)) return "raw-leveldb";
  return undefined;
}

export async function collectSnapshot(options: SnapshotOptions) {
  const { runtimeRoot, dataRoot, scratchRoot, signal } = options;
  const previousEntries = new Map(options.previousEntries.map((entry) => [entry.path, entry]));
  const entries: SnapshotEntry[] = [];
  const excluded: SnapshotManifest["excluded"] = [];
  const validators: Array<() => Promise<void>> = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const logicalPaths = new Set<string>();
  for (const logical of options.logicalFiles) {
    if (
      !validRelativePath(logical.relativePath) ||
      typeof logical.content !== "string" ||
      logicalPaths.has(logical.relativePath)
    ) {
      throw new OfflineBackupError("INVALID_LOGICAL_FILE");
    }
    logicalPaths.add(logical.relativePath);
  }

  async function snapshotDatabase(
    source: string,
    destination: string,
    before: BigIntStats,
  ): Promise<void> {
    await assertRealPath(source);
    await assertSQLiteSidecars(source);
    const scratch = path.join(scratchRoot, `${randomUUID()}.sqlite`);
    // Reserve a private destination before SQLite opens it; its WAL/journal, if
    // any, also stay inside the private local scratch directory.
    const reserved = await fs.open(scratch, "wx", 0o600);
    await reserved.close();
    const database = createDatabaseSync(source, { readOnly: true });
    try {
      if (!sameIdentity(before, await fs.lstat(source, { bigint: true }))) {
        throw new OfflineBackupError("DATABASE_REPLACED");
      }
      await assertRealPath(source);
      database.exec("PRAGMA busy_timeout = 1000");
      await backupDatabase(database, scratch);
    } finally {
      database.close();
    }
    checkAbort(signal);
    // No active-source hardlinks, and no database is ever opened over NFS.
    await fs.copyFile(scratch, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    await syncFile(destination);
    await fs.unlink(scratch);
  }

  async function visit(relative: string): Promise<void> {
    checkAbort(signal);
    const sourceDirectory = path.join(runtimeRoot, relative);
    await assertRealPath(sourceDirectory);
    const directoryStat = await fs.lstat(sourceDirectory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new OfflineBackupError("UNSAFE_SOURCE_LINK");
    }
    const children = (await fs.readdir(sourceDirectory)).sort();
    // Never copy raw LevelDB, even when nested under an unexpected directory.
    const rawLevelDb =
      children.includes("CURRENT") && children.some((name) => /^MANIFEST-\d+$/.test(name));
    if (rawLevelDb) {
      excluded.push({ path: relative, reason: "raw-leveldb" });
      return;
    }
    const databases = new Set<string>();
    const inspected = new Map<string, BigIntStats>();
    for (const name of children) {
      checkAbort(signal);
      if (exclusion(name, relative) || logicalPaths.has(relative ? `${relative}/${name}` : name))
        continue;
      const source = path.join(sourceDirectory, name);
      const value = await fs.lstat(source, { bigint: true });
      if (!value.isFile()) continue;
      inspected.set(name, value);
      const handle = await openRegular(source);
      try {
        if (!sameIdentity(value, await handle.stat({ bigint: true }))) {
          throw new OfflineBackupError("SOURCE_CHANGED");
        }
        const header = buffer.subarray(0, SQLITE_HEADER.length);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead === header.length && header.equals(SQLITE_HEADER)) databases.add(name);
      } finally {
        await handle.close();
      }
    }
    const ignored = (name: string): string | undefined => {
      if (logicalPaths.has(relative ? `${relative}/${name}` : name)) return "caller-logical-export";
      const reason = exclusion(name, relative);
      if (reason) return reason;
      return ["-wal", "-shm", "-journal"].some(
        (suffix) => name.endsWith(suffix) && databases.has(name.slice(0, -suffix.length)),
      )
        ? "sqlite-sidecar"
        : undefined;
    };
    for (const name of children) {
      checkAbort(signal);
      const child = relative ? `${relative}/${name}` : name;
      const reason = ignored(name);
      if (reason) {
        excluded.push({ path: child, reason });
        continue;
      }
      const source = path.join(runtimeRoot, child);
      const destination = path.join(dataRoot, child);
      const before = await fs.lstat(source, { bigint: true });
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
        excluded.push({
          path: child,
          reason: before.isSymbolicLink() ? "symlink" : "non-regular-runtime-object",
        });
        continue;
      }
      const entry: SnapshotEntry = {
        path: child,
        kind: "file",
        mode: Number(before.mode & 0o777n),
      };
      if (before.isDirectory()) {
        entry.kind = "directory";
        await privateDirectory(destination);
        await visit(child);
      } else {
        const initial = inspected.get(name);
        const appendOnly = /^v2\/logs\/\d{4}-\d{2}-\d{2}\.log$/.test(child);
        if (!initial || !equalStamp(stamp(initial), stamp(before))) {
          // Classification from the directory pass is only a hint. A settings
          // save before this file's own snapshot is not a global-round conflict.
          const handle = await openRegular(source);
          try {
            if (!sameIdentity(before, await handle.stat({ bigint: true }))) {
              throw new OfflineBackupError("SOURCE_CHANGED");
            }
            const header = buffer.subarray(0, SQLITE_HEADER.length);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            if (bytesRead === header.length && header.equals(SQLITE_HEADER)) databases.add(name);
            else databases.delete(name);
          } finally {
            await handle.close();
          }
        }
        await assertRealPath(source);
        if (databases.has(name)) {
          entry.kind = "sqlite";
          await snapshotDatabase(source, destination, before);
          await assertRealPath(source);
          if (!sameIdentity(before, await fs.lstat(source, { bigint: true }))) {
            throw new OfflineBackupError("DATABASE_REPLACED");
          }
        } else {
          entry.stamp = stamp(before);
          const old = previousEntries.get(child);
          if (
            old?.kind === "file" &&
            old.sha256 &&
            equalStamp(old.stamp, entry.stamp) &&
            options.previousDataRoot
          ) {
            const oldFile = path.join(options.previousDataRoot, child);
            const oldMode = await fs.lstat(oldFile);
            if (
              (process.getuid && oldMode.uid !== process.getuid()) ||
              (process.platform !== "win32" && (oldMode.mode & 0o077) !== 0)
            ) {
              throw new OfflineBackupError("UNSAFE_BACKUP_FILE");
            }
            // Validate the immutable source too: a manually damaged generation
            // must not silently become the basis of another completed backup.
            if ((await hashFile(oldFile, buffer, signal)) !== old.sha256) {
              throw new OfflineBackupError("PREVIOUS_BACKUP_CHANGED");
            }
            try {
              await fs.link(oldFile, destination);
            } catch (linkError) {
              if (
                !["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"].includes(
                  errorCode(linkError) ?? "",
                )
              )
                throw linkError;
              await fs.copyFile(oldFile, destination, constants.COPYFILE_EXCL);
              await fs.chmod(destination, (before.mode & 0o111n) !== 0n ? 0o700 : 0o600);
              await syncFile(destination);
            }
            entry.sha256 = old.sha256;
            entry.prefixBytes = old.prefixBytes;
          } else {
            Object.assign(
              entry,
              await copyStable(source, destination, before, appendOnly, buffer, signal),
            );
          }
        }
      }
      entries.push(entry);
    }
    validators.push(async () => {
      await assertRealPath(sourceDirectory);
      if (!sameIdentity(directoryStat, await fs.lstat(sourceDirectory, { bigint: true }))) {
        throw new OfflineBackupError("SOURCE_TREE_CHANGED");
      }
    });
    await syncDirectory(path.join(dataRoot, relative));
  }

  await visit("");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const logical of options.logicalFiles) {
    checkAbort(signal);
    if (
      !validRelativePath(logical.relativePath) ||
      typeof logical.content !== "string" ||
      byPath.has(logical.relativePath)
    ) {
      throw new OfflineBackupError("INVALID_LOGICAL_FILE");
    }
    const parts = logical.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const existing = byPath.get(parent);
      if (existing && existing.kind !== "directory")
        throw new OfflineBackupError("INVALID_LOGICAL_FILE");
      await privateDirectory(path.join(dataRoot, parent));
      if (!existing) {
        const entry: SnapshotEntry = { path: parent, kind: "directory", mode: 0o700 };
        entries.push(entry);
        byPath.set(parent, entry);
      }
    }
    await writePrivate(path.join(dataRoot, logical.relativePath), logical.content);
    const entry: SnapshotEntry = {
      path: logical.relativePath,
      kind: "logical",
      mode: 0o600,
      sha256: createHash("sha256").update(logical.content).digest("hex"),
    };
    entries.push(entry);
    byPath.set(entry.path, entry);
  }
  for (const validate of validators) {
    checkAbort(signal);
    await validate();
  }
  // Logical exports can add directories after the filesystem walk's fsync.
  for (const entry of entries) {
    if (entry.kind === "directory") await syncDirectory(path.join(dataRoot, entry.path));
  }
  await syncDirectory(dataRoot);
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  excluded.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { entries, excluded };
}
