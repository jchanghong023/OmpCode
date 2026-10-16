import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OfflineDataRoots } from "@zcode/shared/node";
import {
  checkAbort,
  checkedRoot,
  errorCode,
  isInside,
  OfflineBackupError,
  privateDirectory,
  readJson,
  sameIdentity,
  syncDirectory,
  validRelativePath,
  writePrivate,
} from "./backupFiles.js";
import { acquireBackupLease } from "./backupLease.js";
import { collectSnapshot, type SnapshotManifest } from "./backupSnapshot.js";

export { releaseOfflineDataBackupLease } from "./backupLease.js";

const GENERATION_NAME = /^\d{13}-[a-f0-9-]{36}$/;

interface CurrentGeneration {
  format: 1;
  current: string;
  previous?: string;
  completedAt: string;
}

async function readCurrent(domain: string): Promise<CurrentGeneration | undefined> {
  try {
    const pointer = await readJson<CurrentGeneration>(path.join(domain, "current.json"));
    if (
      pointer.format !== 1 ||
      !GENERATION_NAME.test(pointer.current) ||
      (pointer.previous !== undefined && !GENERATION_NAME.test(pointer.previous)) ||
      typeof pointer.completedAt !== "string"
    ) {
      throw new OfflineBackupError("INVALID_BACKUP_POINTER");
    }
    return pointer;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function readManifest(
  domain: string,
  generation: string,
  domainId: string,
): Promise<SnapshotManifest> {
  const root = path.join(domain, "generations", generation);
  await privateDirectory(root, false);
  await privateDirectory(path.join(root, "data"), false);
  const manifest = await readJson<SnapshotManifest>(path.join(root, "manifest.json"));
  const paths = new Set<string>();
  if (
    manifest.format !== 1 ||
    manifest.status !== "complete" ||
    manifest.generation !== generation ||
    manifest.domainId !== domainId ||
    typeof manifest.runtimeIdentity !== "string" ||
    !Array.isArray(manifest.entries)
  ) {
    throw new OfflineBackupError("INVALID_BACKUP_MANIFEST");
  }
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !validRelativePath(entry.path) ||
      paths.has(entry.path) ||
      !["file", "sqlite", "directory", "logical"].includes(entry.kind) ||
      (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256))
    ) {
      throw new OfflineBackupError("INVALID_BACKUP_MANIFEST");
    }
    paths.add(entry.path);
  }
  return manifest;
}

async function prune(domain: string, pointer: CurrentGeneration | undefined): Promise<void> {
  const generations = path.join(domain, "generations");
  for (const entry of await fs.readdir(domain, { withFileTypes: true })) {
    if (/^\.(?:staging|current)-\d{13}-[a-f0-9-]{36}$/.test(entry.name)) {
      await fs.rm(path.join(domain, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of await fs.readdir(generations, { withFileTypes: true })) {
    if (
      GENERATION_NAME.test(entry.name) &&
      entry.name !== pointer?.current &&
      entry.name !== pointer?.previous
    ) {
      await fs.rm(path.join(generations, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * One complete, non-waiting backup round. Call from the desktop-owned Worker:
 * SQLite adapter calls, local lease release and atomic pointer publication may
 * block that execution context. There is no import-time IO, scheduling or restore.
 *
 * The publication point is current.json's atomic rename. Every generation is
 * immutable after publication. Before that point any error leaves the old pointer
 * untouched; after it, retention cleanup cannot turn a completed round into failure.
 */
export async function runOfflineDataBackup(
  roots: OfflineDataRoots,
  options: {
    logicalFiles?: ReadonlyArray<{ relativePath: string; content: string }>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: "completed" | "busy"; completedAt?: string; backupPath?: string }> {
  const { signal } = options;
  checkAbort(signal);
  if (
    !path.isAbsolute(roots.runtimeRoot) ||
    !path.isAbsolute(roots.persistentRoot) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(roots.domainId)
  ) {
    throw new OfflineBackupError("INVALID_BACKUP_ROOTS");
  }
  const runtime = path.resolve(roots.runtimeRoot);
  const persistent = path.resolve(roots.persistentRoot);
  if (isInside(runtime, persistent) || isInside(persistent, runtime)) {
    throw new OfflineBackupError("OVERLAPPING_BACKUP_ROOTS");
  }
  let release: (() => Promise<void>) | undefined;
  let staging: string | undefined;
  let scratch: string | undefined;
  let pointerTemporary: string | undefined;
  let unpublishedGeneration: string | undefined;
  try {
    // A contending round does not touch or inspect the persistent/NFS root.
    await checkedRoot(runtime, false);
    release = await acquireBackupLease(runtime);
    if (!release) return { status: "busy" };
    checkAbort(signal);
    const runtimeStat = await fs.lstat(runtime, { bigint: true });
    const runtimeIdentity = `${runtimeStat.dev}:${runtimeStat.ino}:${runtimeStat.birthtimeNs}`;
    await checkedRoot(persistent, true, "preserve");
    const domain = path.join(persistent, `.offline-shm-backups-${roots.domainId}`);
    await privateDirectory(domain);
    const generations = path.join(domain, "generations");
    await privateDirectory(generations);
    const current = await readCurrent(domain);
    const previous = current
      ? await readManifest(domain, current.current, roots.domainId)
      : undefined;
    // Only this lease holder owns failed staging and local scratch leftovers.
    await prune(domain, current);
    const workRoot = path.join(runtime, ".offline-shm-backup-work");
    await privateDirectory(workRoot);
    for (const entry of await fs.readdir(workRoot)) {
      if (GENERATION_NAME.test(entry))
        await fs.rm(path.join(workRoot, entry), { recursive: true, force: true });
    }
    checkAbort(signal);
    const generation = `${Date.now()}-${randomUUID()}`;
    staging = path.join(domain, `.staging-${generation}`);
    scratch = path.join(workRoot, generation);
    await privateDirectory(staging);
    await privateDirectory(scratch);
    const data = path.join(staging, "data");
    await privateDirectory(data);
    const sameRuntime = previous?.runtimeIdentity === runtimeIdentity;
    const snapshot = await collectSnapshot({
      runtimeRoot: runtime,
      dataRoot: data,
      scratchRoot: scratch,
      previousDataRoot:
        current && sameRuntime ? path.join(generations, current.current, "data") : undefined,
      previousEntries: sameRuntime && previous ? previous.entries : [],
      logicalFiles: options.logicalFiles ?? [],
      signal,
    });
    if (!sameIdentity(runtimeStat, await fs.lstat(runtime, { bigint: true }))) {
      throw new OfflineBackupError("RUNTIME_REPLACED");
    }
    const completedAt = new Date().toISOString();
    const present = new Set(snapshot.entries.map((entry) => entry.path));
    const manifest: SnapshotManifest = {
      format: 1,
      status: "complete",
      domainId: roots.domainId,
      generation,
      completedAt,
      runtimeRoot: roots.runtimeRoot,
      persistentRoot: roots.persistentRoot,
      runtimeIdentity,
      scope: "complete-runtime-only",
      consistency: "individual-sqlite-transactions-and-stable-files-not-global-transaction",
      recovery:
        "Manually copy data/ into an inactive empty runtime root, preserving private permissions. Browser sidecars require manual import of origin localStorage and partition cookies through Chromium APIs; they are not raw browser profiles. Never overlay original persistent data or restore active SQLite WAL files. No automatic restore is performed.",
      deletionScope: "same-runtime-incarnation-only-never-original-persistent-root",
      deletedSincePrevious:
        sameRuntime && previous
          ? previous.entries.filter((entry) => !present.has(entry.path)).map((entry) => entry.path)
          : [],
      entries: snapshot.entries,
      excluded: snapshot.excluded,
    };
    checkAbort(signal);
    await writePrivate(path.join(staging, "manifest.json"), manifest);
    await syncDirectory(staging);
    checkAbort(signal);
    const generationRoot = path.join(generations, generation);
    await fs.rename(staging, generationRoot);
    staging = undefined;
    unpublishedGeneration = generationRoot;
    await syncDirectory(generations);
    const pointer: CurrentGeneration = {
      format: 1,
      current: generation,
      previous: current?.current,
      completedAt,
    };
    pointerTemporary = path.join(domain, `.current-${generation}`);
    await writePrivate(pointerTemporary, pointer);
    checkAbort(signal);
    // Synchronous ONLY inside the Worker. Worker termination cannot release its
    // lease while an asynchronous NFS rename later overwrites a successor pointer.
    renameSync(pointerTemporary, path.join(domain, "current.json"));
    pointerTemporary = undefined;
    // From this point onward the complete generation is visible and must not be
    // removed, even when the directory fsync or retention cleanup fails.
    unpublishedGeneration = undefined;
    await syncDirectory(domain);
    try {
      await prune(domain, pointer);
    } catch {
      // A later round prunes recognized leftovers; never invalidate committed data.
    }
    return { status: "completed", completedAt, backupPath: generationRoot };
  } catch (error) {
    if (signal?.aborted) throw new OfflineBackupError("ABORTED");
    if (error instanceof OfflineBackupError) throw error;
    const code = errorCode(error);
    // Native SQLite errors sometimes have numeric codes. Keep the worker error
    // deterministic and sanitized instead of forwarding arbitrary exception text.
    throw new OfflineBackupError(
      code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "BACKUP_IO_FAILED",
    );
  } finally {
    try {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
      if (pointerTemporary) await fs.rm(pointerTemporary, { force: true });
      if (unpublishedGeneration)
        await fs.rm(unpublishedGeneration, { recursive: true, force: true });
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    } catch {
      // Termination/IO failure can leave one round's staging; the next lease holder
      // reclaims only this service's recognized names, never old user data.
    } finally {
      await release?.();
    }
  }
}
