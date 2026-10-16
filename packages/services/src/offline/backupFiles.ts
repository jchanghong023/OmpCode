import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class OfflineBackupError extends Error {
  override readonly name = "OfflineDataBackupError";

  constructor(readonly code: string) {
    // Errors cross the worker boundary: never expose paths, file contents or abort reasons.
    super(`Offline data backup failed (${code})`);
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OfflineBackupError("ABORTED");
  signal?.throwIfAborted();
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export interface FileStamp {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export function stamp(value: BigIntStats): FileStamp {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
  };
}

export function equalStamp(a: FileStamp | undefined, b: FileStamp): boolean {
  return (
    !!a &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !/[\\:]/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !(process.platform === "win32" && /[. ]$/.test(part)),
      )
  );
}

/** Walk components explicitly: recursive mkdir/realpath alone would follow an implanted symlink. */
export async function checkedRoot(
  directory: string,
  create: boolean,
  privateMode: "required" | "preserve" = "required",
): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    const value = await fs.lstat(current);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      throw new OfflineBackupError("UNSAFE_DIRECTORY");
    }
  }
  if (privateMode === "required") {
    await privateDirectory(resolved, false);
  }
}

export async function privateDirectory(directory: string, create = true): Promise<void> {
  if (create) {
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
  }
  const value = await fs.lstat(directory);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (process.getuid && value.uid !== process.getuid()) ||
    (process.platform !== "win32" && (value.mode & 0o077) !== 0)
  ) {
    throw new OfflineBackupError("UNSAFE_PRIVATE_DIRECTORY");
  }
}

export async function assertRealPath(filename: string): Promise<void> {
  const actual = await fs.realpath(filename);
  const expected = path.resolve(filename);
  // Windows realpath can normalize drive-letter casing without following a link.
  if (
    process.platform === "win32"
      ? actual.toLowerCase() !== expected.toLowerCase()
      : actual !== expected
  ) {
    throw new OfflineBackupError("UNSAFE_SOURCE_LINK");
  }
}

export async function openRegular(filename: string): Promise<fs.FileHandle> {
  await assertRealPath(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new OfflineBackupError("UNSAFE_FILE");
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameIdentity(before, await handle.stat({ bigint: true }))) {
      throw new OfflineBackupError("SOURCE_CHANGED");
    }
    await assertRealPath(filename);
    if (process.platform === "linux") {
      const descriptor = await fs.realpath(`/proc/self/fd/${handle.fd}`);
      if (descriptor !== path.resolve(filename)) throw new OfflineBackupError("UNSAFE_SOURCE_LINK");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** SQLite opens sidecars itself; reject planted links before handing it a path. */
export async function assertSQLiteSidecars(filename: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${filename}${suffix}`;
    try {
      const value = await fs.lstat(sidecar);
      if (!value.isFile() || value.isSymbolicLink())
        throw new OfflineBackupError("UNSAFE_SQLITE_SIDECAR");
      await assertRealPath(sidecar);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

export async function readJson<T>(filename: string): Promise<T> {
  const handle = await openRegular(filename);
  try {
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally {
    await handle.close();
  }
}

export async function writePrivate(filename: string, value: string | object): Promise<void> {
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncFile(filename: string): Promise<void> {
  const access = process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
  const handle = await fs.open(filename, access | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") await syncFile(directory);
}

export async function hashFile(
  filename: string,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  const handle = await openRegular(filename);
  try {
    const before = stamp(await handle.stat({ bigint: true }));
    const hash = createHash("sha256");
    let position = 0;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (!equalStamp(before, stamp(await handle.stat({ bigint: true })))) {
      throw new OfflineBackupError("SOURCE_CHANGED");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
