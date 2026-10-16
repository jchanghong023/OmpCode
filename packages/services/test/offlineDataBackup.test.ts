import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { OfflineDataRoots } from "@zcode/shared/node";
import {
  releaseOfflineDataBackupLease,
  runOfflineDataBackup,
} from "../src/offline/offlineDataBackup.js";
import { createDatabaseSync } from "../src/session/tasksDatabase/sqlite.js";

interface Manifest {
  status: string;
  runtimeIdentity: string;
  scope: string;
  consistency: string;
  deletionScope: string;
  deletedSincePrevious: string[];
  entries: Array<{ path: string; kind: string; sha256?: string; prefixBytes?: number }>;
  excluded: Array<{ path: string; reason: string }>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "offline-data-backup-"));
  const roots: OfflineDataRoots = {
    runtimeRoot: join(root, "runtime"),
    persistentRoot: join(root, "persistent"),
    domainId: "isolated-test-domain",
  };
  await mkdir(roots.runtimeRoot, { mode: 0o700 });
  return { root, roots };
}

async function completed(
  roots: OfflineDataRoots,
  logicalFiles?: Array<{ relativePath: string; content: string }>,
) {
  const result = await runOfflineDataBackup(roots, { logicalFiles });
  assert.equal(result.status, "completed");
  assert.match(result.completedAt!, /^\d{4}-\d\d-\d\dT/);
  assert.ok(result.backupPath);
  const manifest = JSON.parse(
    await readFile(join(result.backupPath, "manifest.json"), "utf8"),
  ) as Manifest;
  assert.equal(manifest.status, "complete");
  return { path: result.backupPath, manifest };
}

async function current(roots: OfflineDataRoots) {
  return JSON.parse(
    await readFile(
      join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`, "current.json"),
      "utf8",
    ),
  ) as {
    current: string;
    previous?: string;
  };
}

// Runs at explicit production cancellation checkpoints, not a timing race or a
// filesystem mock. Only our isolated active source is changed by these callbacks.
function withCheckpoint(action: () => void) {
  const controller = new AbortController();
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value() {
      action();
      original();
    },
  });
  return controller;
}

function stagedFile(roots: OfflineDataRoots, relative: string): string | undefined {
  const domain = join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`);
  if (!existsSync(domain)) return undefined;
  const staging = readdirSync(domain).find((name) => name.startsWith(".staging-"));
  if (!staging) return undefined;
  const candidate = join(domain, staging, "data", relative);
  return existsSync(candidate) ? candidate : undefined;
}

async function childReady(child: ChildProcess, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let diagnostics = "";
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      if (output.includes("held\n")) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) =>
      finish(new Error(`Backup child exited ${code}: ${diagnostics}`));
    const onDiagnostics = (chunk: Buffer) => {
      diagnostics += String(chunk);
    };
    const onAbort = () => finish(new Error("Backup child handshake cancelled"));
    function finish(error?: Error) {
      signal.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onDiagnostics);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onDiagnostics);
    child.once("error", onError);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

test("complete generation contains private stable files and logical browser state, not live LevelDB or links", async () => {
  const { root, roots } = await fixture();
  try {
    await mkdir(roots.persistentRoot, { mode: 0o755 });
    const originalPersistentMode = (await lstat(roots.persistentRoot)).mode;
    const neighboringDomain = join(roots.persistentRoot, ".offline-shm-backups-another-domain");
    await mkdir(neighboringDomain, { mode: 0o700 });
    await writeFile(join(neighboringDomain, "sentinel"), "another user's namespace");
    await writeFile(join(roots.persistentRoot, "old-user-data.json"), "do not change");
    await mkdir(join(roots.runtimeRoot, "v2"));
    await writeFile(join(roots.runtimeRoot, "v2", "settings.json"), '{"theme":"dark"}');
    await writeFile(join(roots.runtimeRoot, "run.sh"), "#!/bin/sh\necho local\n", { mode: 0o755 });
    await mkdir(join(roots.runtimeRoot, "electron", "Local Storage", "leveldb"), {
      recursive: true,
    });
    await writeFile(
      join(roots.runtimeRoot, "electron", "Local Storage", "leveldb", "CURRENT"),
      "MANIFEST-000001\n",
    );
    await writeFile(
      join(roots.runtimeRoot, "electron", "Local Storage", "leveldb", "MANIFEST-000001"),
      "raw",
    );
    await mkdir(join(roots.runtimeRoot, "electron", "Cache"), { recursive: true });
    await writeFile(join(roots.runtimeRoot, "electron", "Cache", "cache-data"), "rebuildable");
    await writeFile(join(roots.runtimeRoot, "app.lock"), "owner");
    await writeFile(join(roots.runtimeRoot, "app.pid"), "42");
    await mkdir(join(root, "external"));
    await writeFile(join(root, "external", "secret"), "never traverse");
    await symlink(
      join(root, "external"),
      join(roots.runtimeRoot, "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const logical = JSON.stringify({
      version: 1,
      origins: [{ origin: "file://", localStorage: [["settings", "saved"]] }],
    });
    await writeFile(
      join(roots.runtimeRoot, "electron", "first-party-browser-state.json"),
      "older sidecar content",
    );
    await mkdir(join(roots.runtimeRoot, "electron", "other-app"));
    await writeFile(
      join(roots.runtimeRoot, "electron", "other-app", "first-party-browser-state.json"),
      '{"other":"preserved"}',
    );
    const backup = await completed(roots, [
      { relativePath: "electron/first-party-browser-state.json", content: logical },
    ]);
    assert.equal(
      await readFile(join(backup.path, "data", "v2", "settings.json"), "utf8"),
      '{"theme":"dark"}',
    );
    assert.equal(
      await readFile(
        join(backup.path, "data", "electron", "first-party-browser-state.json"),
        "utf8",
      ),
      logical,
    );
    assert.equal(
      await readFile(
        join(backup.path, "data", "electron", "other-app", "first-party-browser-state.json"),
        "utf8",
      ),
      '{"other":"preserved"}',
    );
    assert.equal(existsSync(join(backup.path, "data", "electron", "Local Storage")), false);
    assert.equal(existsSync(join(backup.path, "data", "external-link")), false);
    assert.equal(existsSync(join(backup.path, "data", "app.lock")), false);
    assert.equal(existsSync(join(backup.path, "data", "app.pid")), false);
    assert.ok(backup.manifest.excluded.some((entry) => entry.reason === "browser-raw-storage"));
    assert.ok(backup.manifest.excluded.some((entry) => entry.reason === "symlink"));
    assert.equal(
      await readFile(join(roots.persistentRoot, "old-user-data.json"), "utf8"),
      "do not change",
    );
    assert.equal((await lstat(roots.persistentRoot)).mode, originalPersistentMode);
    assert.equal(
      await readFile(join(neighboringDomain, "sentinel"), "utf8"),
      "another user's namespace",
    );
    if (process.platform !== "win32") {
      for (const directory of [
        backup.path,
        join(backup.path, "data"),
        join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`),
      ]) {
        assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      }
      assert.equal((await lstat(join(backup.path, "manifest.json"))).mode & 0o777, 0o600);
      assert.equal(
        (await lstat(join(backup.path, "data", "v2", "settings.json"))).mode & 0o777,
        0o600,
      );
      assert.equal((await lstat(join(backup.path, "data", "run.sh"))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent multi-buffer files and nested logical exports retain complete bytes across generations", async () => {
  const { root, roots } = await fixture();
  try {
    const files = Array.from({ length: 8 }, (_, index) => {
      const relative = index < 6 ? `file-${index}.bin` : `nested/deeper/file-${index}.bin`;
      const content = Buffer.alloc(2 * 1024 * 1024 + 31 + index, 0x20 + index);
      content.fill(0x60 + index, 1024 * 1024);
      return { relative, content };
    });
    await mkdir(join(roots.runtimeRoot, "nested", "deeper"), { recursive: true });
    for (const file of files) await writeFile(join(roots.runtimeRoot, file.relative), file.content);
    const logical = {
      relativePath: "electron/new-app/export/nested/first-party-browser-state.json",
      content: '{"version":1,"origins":[]}',
    };
    const first = await completed(roots, [logical]);
    const second = await completed(roots, [logical]);
    for (const backup of [first, second]) {
      for (const file of files) {
        assert.deepEqual(await readFile(join(backup.path, "data", file.relative)), file.content);
        assert.equal(
          backup.manifest.entries.find((entry) => entry.path === file.relative)?.sha256,
          createHash("sha256").update(file.content).digest("hex"),
        );
      }
      assert.equal(
        await readFile(join(backup.path, "data", logical.relativePath), "utf8"),
        logical.content,
      );
      for (const parent of [
        "electron",
        "electron/new-app",
        "electron/new-app/export",
        "electron/new-app/export/nested",
      ]) {
        assert.equal(
          backup.manifest.entries.find((entry) => entry.path === parent)?.kind,
          "directory",
        );
      }
      const paths = backup.manifest.entries.map((entry) => entry.path);
      assert.deepEqual(
        paths,
        [...paths].sort((a, b) => a.localeCompare(b, "en")),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged files reuse only immutable generations and retention keeps current and previous", async () => {
  const { root, roots } = await fixture();
  try {
    const source = join(roots.runtimeRoot, "settings.json");
    await writeFile(source, "original");
    const first = await completed(roots);
    const second = await completed(roots);
    const active = await lstat(source, { bigint: true });
    const old = await lstat(join(first.path, "data", "settings.json"), { bigint: true });
    const reused = await lstat(join(second.path, "data", "settings.json"), { bigint: true });
    assert.notEqual(active.ino, old.ino, "active source must never be hardlinked");
    assert.equal(old.ino, reused.ino, "same-filesystem immutable generation can be hardlinked");
    await writeFile(source, "updated independently");
    assert.equal(await readFile(join(first.path, "data", "settings.json"), "utf8"), "original");
    assert.equal(await readFile(join(second.path, "data", "settings.json"), "utf8"), "original");
    const third = await completed(roots);
    assert.equal(
      await readFile(join(third.path, "data", "settings.json"), "utf8"),
      "updated independently",
    );
    assert.deepEqual(await current(roots), {
      format: 1,
      current: basename(third.path),
      previous: basename(second.path),
      completedAt: JSON.parse(await readFile(join(third.path, "manifest.json"), "utf8"))
        .completedAt,
    });
    assert.deepEqual(
      (
        await readdir(
          join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`, "generations"),
        )
      ).sort(),
      [basename(second.path), basename(third.path)].sort(),
    );
    assert.equal(existsSync(first.path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mid-copy rewrite rejects the round and leaves last-good pointer and content unchanged", async () => {
  const { root, roots } = await fixture();
  try {
    const source = join(roots.runtimeRoot, "large.bin");
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const good = await completed(roots);
    // Ensure this round copies, rather than reusing its previous immutable file.
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 0x62));
    let mutated = false;
    const checkpoint = withCheckpoint(() => {
      const destination = stagedFile(roots, "large.bin");
      if (!mutated && destination && statSync(destination).size > 0) {
        mutated = true;
        writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x63));
      }
    });
    await assert.rejects(
      runOfflineDataBackup(roots, { signal: checkpoint.signal }),
      /SOURCE_CHANGED/,
    );
    assert.equal(mutated, true);
    assert.equal((await current(roots)).current, basename(good.path));
    assert.deepEqual(
      await readFile(join(good.path, "data", "large.bin")),
      Buffer.alloc(3 * 1024 * 1024, 0x61),
    );
    assert.equal(
      (await readdir(join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`))).some(
        (name) => name.startsWith(".staging-"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Online Backup includes committed WAL and excludes an in-flight transaction, with no sidecar dependency", async () => {
  const { root, roots } = await fixture();
  const source = join(roots.runtimeRoot, "extensionless-store");
  const database = createDatabaseSync(source);
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    database.exec("INSERT INTO settings VALUES (1, 'committed-in-wal')");
    assert.ok((await lstat(`${source}-wal`)).size > 0);
    database.exec("BEGIN IMMEDIATE; INSERT INTO settings VALUES (2, 'not-committed')");
    const ordinary = [
      { relative: "a-ordinary.bin", content: Buffer.alloc(1024 * 1024 + 19, 0x31) },
      { relative: "nested/ordinary.bin", content: Buffer.alloc(1024 * 1024 + 23, 0x72) },
    ];
    await mkdir(join(roots.runtimeRoot, "nested"));
    for (const file of ordinary)
      await writeFile(join(roots.runtimeRoot, file.relative), file.content);
    const backup = await completed(roots);
    for (const file of ordinary) {
      assert.deepEqual(await readFile(join(backup.path, "data", file.relative)), file.content);
    }
    const snapshotPath = join(backup.path, "data", "extensionless-store");
    assert.equal(existsSync(`${snapshotPath}-wal`), false);
    assert.equal(existsSync(`${snapshotPath}-shm`), false);
    assert.equal(
      backup.manifest.entries.find((entry) => entry.path === "extensionless-store")?.kind,
      "sqlite",
    );
    assert.ok(
      backup.manifest.excluded.some(
        (entry) => entry.path === "extensionless-store-wal" && entry.reason === "sqlite-sidecar",
      ),
    );
    const snapshot = createDatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.deepEqual(
        snapshot
          .prepare("SELECT id, value FROM settings ORDER BY id")
          .all()
          .map((row) => [row.id, row.value]),
        [[1, "committed-in-wal"]],
      );
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      snapshot.close();
    }
    database.exec("ROLLBACK");
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("per-file snapshots tolerate later settings saves and ongoing WAL/log appends", async () => {
  const { root, roots } = await fixture();
  const database = createDatabaseSync(join(roots.runtimeRoot, "state.sqlite"));
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE activity (id INTEGER PRIMARY KEY)",
    );
    await mkdir(join(roots.runtimeRoot, "v2", "logs"), { recursive: true });
    const log = join(roots.runtimeRoot, "v2", "logs", "2026-10-16.log");
    await writeFile(log, '{"seed":true}\n');
    await writeFile(
      join(roots.runtimeRoot, "v2", "logs", "2026-10-15.log"),
      '{"complete":true}\n{"partial":',
    );
    const settings = join(roots.runtimeRoot, "a-settings.json");
    await writeFile(settings, '{"before":true}');
    await writeFile(join(roots.runtimeRoot, "z-tail.bin"), Buffer.alloc(3 * 1024 * 1024, 0x61));
    let writes = 0;
    let savedAfterSnapshot = false;
    const checkpoint = withCheckpoint(() => {
      writes += 1;
      database.exec(`INSERT INTO activity VALUES (${writes})`);
      appendFileSync(log, `${JSON.stringify({ record: writes })}\n`);
      const tail = stagedFile(roots, "z-tail.bin");
      if (!savedAfterSnapshot && tail && statSync(tail).size > 0) {
        savedAfterSnapshot = true;
        const temporary = join(roots.runtimeRoot, "settings.tmp");
        writeFileSync(temporary, '{"after":true}');
        renameSync(temporary, settings);
      }
    });
    const result = await runOfflineDataBackup(roots, { signal: checkpoint.signal });
    assert.equal(result.status, "completed");
    assert.ok(result.backupPath);
    assert.ok(writes > 5);
    assert.equal(savedAfterSnapshot, true);
    assert.equal(await readFile(settings, "utf8"), '{"after":true}');
    assert.equal(
      await readFile(join(result.backupPath, "data", "a-settings.json"), "utf8"),
      '{"before":true}',
    );
    const savedLog = await readFile(
      join(result.backupPath, "data", "v2", "logs", "2026-10-16.log"),
      "utf8",
    );
    assert.ok(savedLog.endsWith("\n"));
    for (const line of savedLog.trim().split("\n")) assert.equal(typeof JSON.parse(line), "object");
    assert.equal(
      await readFile(join(result.backupPath, "data", "v2", "logs", "2026-10-15.log"), "utf8"),
      '{"complete":true}\n',
    );
    const manifest = JSON.parse(
      await readFile(join(result.backupPath, "manifest.json"), "utf8"),
    ) as Manifest;
    assert.equal(
      manifest.entries.find((entry) => entry.path === "v2/logs/2026-10-16.log")?.prefixBytes,
      Buffer.byteLength(savedLog),
    );
    const snapshot = createDatabaseSync(join(result.backupPath, "data", "state.sqlite"), {
      readOnly: true,
    });
    try {
      const count = snapshot.prepare("SELECT COUNT(*) AS total FROM activity").get()
        ?.total as number;
      assert.ok(count > 0 && count <= writes);
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      snapshot.close();
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("append-only log prefix snapshots still reject a same-size in-place rewrite", async () => {
  const { root, roots } = await fixture();
  try {
    await mkdir(join(roots.runtimeRoot, "v2", "logs"), { recursive: true });
    const relative = "v2/logs/2026-10-16.log";
    const source = join(roots.runtimeRoot, relative);
    const initial = `${JSON.stringify({ line: "a".repeat(256 * 1024) })}\n`;
    await writeFile(source, initial);
    const good = await completed(roots);
    await writeFile(source, initial.replaceAll("a", "b"));
    let rewritten = false;
    const checkpoint = withCheckpoint(() => {
      const destination = stagedFile(roots, relative);
      if (!rewritten && destination && statSync(destination).size > 0) {
        rewritten = true;
        writeFileSync(source, initial.replaceAll("a", "c"));
      }
    });
    await assert.rejects(
      runOfflineDataBackup(roots, { signal: checkpoint.signal }),
      /SOURCE_CHANGED/,
    );
    assert.equal(rewritten, true);
    assert.equal((await current(roots)).current, basename(good.path));
    assert.equal(await readFile(join(good.path, "data", relative), "utf8"), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed SQLite snapshot never publishes raw database/WAL or replaces last-good", async () => {
  const { root, roots } = await fixture();
  try {
    await writeFile(join(roots.runtimeRoot, "config.json"), "safe");
    const good = await completed(roots);
    const corrupt = Buffer.alloc(4096);
    Buffer.from("SQLite format 3\0").copy(corrupt);
    await writeFile(join(roots.runtimeRoot, "corrupt-store"), corrupt);
    await writeFile(join(roots.runtimeRoot, "corrupt-store-wal"), "untrusted raw sidecar");
    await assert.rejects(runOfflineDataBackup(roots), /Offline data backup failed/);
    assert.equal((await current(roots)).current, basename(good.path));
    assert.equal(await readFile(join(good.path, "data", "config.json"), "utf8"), "safe");
    assert.deepEqual(
      await readdir(
        join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`, "generations"),
      ),
      [basename(good.path)],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty new runtime is a distinct incarnation, not deletion of previous runtime or persistent data", async () => {
  const { root, roots } = await fixture();
  try {
    await mkdir(roots.persistentRoot, { mode: 0o700 });
    await writeFile(join(roots.persistentRoot, "legacy.json"), "never migrate or delete");
    await writeFile(join(roots.runtimeRoot, "settings.json"), "last runtime");
    const good = await completed(roots);
    await rename(roots.runtimeRoot, join(root, "old-runtime"));
    await mkdir(roots.runtimeRoot, { mode: 0o700 });
    const empty = await completed(roots);
    assert.notEqual(empty.manifest.runtimeIdentity, good.manifest.runtimeIdentity);
    assert.deepEqual(empty.manifest.entries, []);
    assert.deepEqual(empty.manifest.deletedSincePrevious, []);
    assert.equal(
      empty.manifest.deletionScope,
      "same-runtime-incarnation-only-never-original-persistent-root",
    );
    assert.equal((await current(roots)).previous, basename(good.path));
    assert.equal(await readFile(join(good.path, "data", "settings.json"), "utf8"), "last runtime");
    assert.equal(
      await readFile(join(roots.persistentRoot, "legacy.json"), "utf8"),
      "never migrate or delete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging cleanup is bounded to owned names and same-runtime deletions remain generation-local", async () => {
  const { root, roots } = await fixture();
  try {
    await writeFile(join(roots.runtimeRoot, "old.json"), "previous only");
    const first = await completed(roots);
    const domain = join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`);
    const orphan = "1000000000000-11111111-1111-4111-8111-111111111111";
    const staging = join(domain, `.staging-${orphan}`);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, "partial"), "not complete");
    const unreferenced = join(domain, "generations", orphan);
    await mkdir(unreferenced, { mode: 0o700 });
    await writeFile(join(unreferenced, "partial"), "not current");
    const scratch = join(roots.runtimeRoot, ".offline-shm-backup-work", orphan);
    await mkdir(scratch, { mode: 0o700 });
    await writeFile(join(scratch, "partial"), "local leftover");
    await writeFile(join(domain, "unrelated-user-file"), "leave untouched");
    await rm(join(roots.runtimeRoot, "old.json"));
    const second = await completed(roots);
    assert.deepEqual(second.manifest.deletedSincePrevious, ["old.json"]);
    assert.equal(existsSync(join(second.path, "data", "old.json")), false);
    assert.equal(await readFile(join(first.path, "data", "old.json"), "utf8"), "previous only");
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(unreferenced), false);
    assert.equal(existsSync(scratch), false);
    assert.equal(await readFile(join(domain, "unrelated-user-file"), "utf8"), "leave untouched");
    assert.deepEqual(await readdir(join(roots.runtimeRoot, ".offline-shm-backup-work")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "cross-process overlap is busy without persistent IO and a dead owner is reclaimed",
  { timeout: 30_000 },
  async (t) => {
    const { root, roots } = await fixture();
    const engine = new URL("../src/offline/offlineDataBackup.ts", import.meta.url).href;
    const script = `
    import { writeFileSync } from 'node:fs';
    import { runOfflineDataBackup } from ${JSON.stringify(engine)};
    const controller = new AbortController();
    let checks = 0;
    Object.defineProperty(controller.signal, 'throwIfAborted', { value() {
      if (++checks === 2) {
        writeFileSync(1, 'held\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }});
    await runOfflineDataBackup(${JSON.stringify(roots)}, {signal: controller.signal});
  `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: new URL("../../..", import.meta.url),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await childReady(child, t.signal);
      assert.deepEqual(await runOfflineDataBackup(roots), { status: "busy" });
      assert.equal(existsSync(roots.persistentRoot), false);
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const backup = await completed(roots);
      assert.deepEqual(backup.manifest.entries, []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Worker lease cleanup matches exact owner and never visits persistent root", async () => {
  const { root, roots } = await fixture();
  try {
    const lock = join(roots.runtimeRoot, ".offline-shm-backup-round");
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        threadId: 77,
        token: "fixture-owner",
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    await releaseOfflineDataBackupLease(roots, { pid: process.pid, threadId: 78 });
    assert.equal(existsSync(lock), true);
    await releaseOfflineDataBackupLease(roots, { pid: process.pid + 1, threadId: 77 });
    assert.equal(existsSync(lock), true);
    await releaseOfflineDataBackupLease(roots, { pid: process.pid, threadId: 77 });
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(roots.persistentRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation before admission touches no persistent data; mid-copy abort preserves last-good", async () => {
  const { root, roots } = await fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort("sensitive user reason");
    await assert.rejects(runOfflineDataBackup(roots, { signal: cancelled.signal }), /ABORTED/);
    assert.equal(existsSync(roots.persistentRoot), false);
    const source = join(roots.runtimeRoot, "large.bin");
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const good = await completed(roots);
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 0x62));
    const peers = Array.from({ length: 6 }, (_, index) => `peer-${index}.bin`);
    for (const peer of peers) {
      await writeFile(join(roots.runtimeRoot, peer), Buffer.alloc(3 * 1024 * 1024, 0x70));
    }
    let abortedDuringCopy = false;
    const checkpoint = withCheckpoint(() => {
      const copying = ["large.bin", ...peers].filter((relative) => {
        const destination = stagedFile(roots, relative);
        return destination && statSync(destination).size > 0;
      });
      if (copying.length >= 2) {
        abortedDuringCopy = true;
        checkpoint.abort("private abort detail");
      }
    });
    await assert.rejects(runOfflineDataBackup(roots, { signal: checkpoint.signal }), /ABORTED/);
    assert.equal(abortedDuringCopy, true);
    assert.equal((await current(roots)).current, basename(good.path));
    assert.equal(existsSync(join(roots.runtimeRoot, ".offline-shm-backup-round")), false);
    assert.deepEqual(
      await readFile(join(good.path, "data", "large.bin")),
      Buffer.alloc(3 * 1024 * 1024, 0x61),
    );
    const domain = join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`);
    assert.equal(
      (await readdir(domain)).some((name) => name.startsWith(".staging-")),
      false,
    );
    assert.deepEqual(await readdir(join(roots.runtimeRoot, ".offline-shm-backup-work")), []);
    // 返回后立即启动下一轮；旧任务不得继续写入已清理的目录或占用上一轮句柄。
    const recovered = await completed(roots);
    assert.equal((await current(roots)).previous, basename(good.path));
    for (const peer of peers) {
      assert.deepEqual(
        await readFile(join(recovered.path, "data", peer)),
        Buffer.alloc(3 * 1024 * 1024, 0x70),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe backup roots and logical path traversal fail without modifying external data", async () => {
  const { root, roots } = await fixture();
  try {
    await mkdir(roots.persistentRoot, { mode: 0o700 });
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(
      outside,
      join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(runOfflineDataBackup(roots), /UNSAFE_PRIVATE_DIRECTORY/);
    assert.deepEqual(await readdir(outside), []);
    await rm(join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`), {
      force: true,
      recursive: true,
    });
    await assert.rejects(
      runOfflineDataBackup(roots, {
        logicalFiles: [{ relativePath: "../escaped.json", content: "private" }],
      }),
      /INVALID_LOGICAL_FILE/,
    );
    assert.equal(
      existsSync(
        join(roots.persistentRoot, `.offline-shm-backups-${roots.domainId}`, "escaped.json"),
      ),
      false,
    );
    assert.equal(existsSync(join(root, "escaped.json")), false);
    await assert.rejects(
      runOfflineDataBackup({ ...roots, persistentRoot: join(roots.runtimeRoot, "overlap") }),
      /OVERLAPPING_BACKUP_ROOTS/,
    );
    if (process.platform !== "win32") {
      await chmod(roots.runtimeRoot, 0o755);
      await assert.rejects(runOfflineDataBackup(roots), /UNSAFE_PRIVATE_DIRECTORY/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
