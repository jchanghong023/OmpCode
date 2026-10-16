import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import type { OfflineDataRoots } from "@zcode/shared/node";
import { createDatabaseSync, type SqliteDatabase } from "../session/tasksDatabase/sqlite.js";
import {
  assertRealPath,
  assertSQLiteSidecars,
  checkedRoot,
  errorCode,
  OfflineBackupError,
  readJson,
  writePrivate,
} from "./backupFiles.js";

const LOCK_NAME = ".offline-shm-backup-round";
const GUARD_NAME = ".offline-shm-backup-lease.sqlite";

interface LeaseOwner {
  pid: number;
  threadId: number;
  token: string;
  createdAt: number;
}

/**
 * SQLite's OS-backed local write lease avoids compare/unlink races when two
 * processes recover the same orphaned file lock. No tables or user data live in
 * this database. Never unlink it: another process may already have it open.
 * Worker/process teardown closes its handle, so there is no age-based stealing
 * of a live owner that happens to be blocked on NFS.
 */
async function acquireGuard(runtimeRoot: string): Promise<SqliteDatabase | undefined> {
  const filename = path.join(runtimeRoot, GUARD_NAME);
  try {
    const handle = await fs.open(filename, "wx", 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const metadata = await fs.lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new OfflineBackupError("UNSAFE_BACKUP_LEASE");
  }
  await assertRealPath(filename);
  await assertSQLiteSidecars(filename);
  let guard: SqliteDatabase | undefined;
  try {
    guard = createDatabaseSync(filename);
    guard.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return guard;
  } catch (error) {
    guard?.close();
    const code = errorCode(error);
    const numericCode =
      error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
    if (
      code?.startsWith("SQLITE_BUSY") ||
      code?.startsWith("SQLITE_LOCKED") ||
      numericCode === 5 ||
      numericCode === 6
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Only call after the specified Worker has exited. Exact ownership is inspected
 * under the same local kernel lease, never while a successor can replace it.
 * This is diagnostic cleanup; admission never relies on a stale JSON/PID record.
 */
export async function releaseOfflineDataBackupLease(
  roots: OfflineDataRoots,
  owner: { pid: number; threadId: number },
): Promise<void> {
  await checkedRoot(roots.runtimeRoot, false);
  const guard = await acquireGuard(roots.runtimeRoot);
  if (!guard) return;
  try {
    const filename = path.join(roots.runtimeRoot, LOCK_NAME);
    try {
      const record = await readJson<LeaseOwner>(filename);
      if (record.pid === owner.pid && record.threadId === owner.threadId) unlinkSync(filename);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  } finally {
    guard.close();
  }
}

/** Non-waiting, cross-process admission; the adapter executes only on the local runtime. */
export async function acquireBackupLease(
  runtimeRoot: string,
): Promise<(() => Promise<void>) | undefined> {
  const guard = await acquireGuard(runtimeRoot);
  if (!guard) return undefined;
  const filename = path.join(runtimeRoot, LOCK_NAME);
  const owner: LeaseOwner = {
    pid: process.pid,
    threadId,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  try {
    // With the kernel lease held, any old owner record is necessarily stale.
    // Unlink the entry itself, never follow a planted symbolic link.
    await fs.unlink(filename).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    await writePrivate(filename, owner);
    return async () => {
      try {
        unlinkSync(filename);
      } catch (error) {
        if (errorCode(error) !== "ENOENT")
          throw new OfflineBackupError("BACKUP_LEASE_CLEANUP_FAILED");
      } finally {
        // Closing rolls back the empty transaction and releases the OS lock.
        guard.close();
      }
    };
  } catch (error) {
    guard.close();
    throw error;
  }
}
