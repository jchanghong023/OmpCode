import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupDatabase, createDatabaseSync } from "../src/session/tasksDatabase/sqlite.js";

test("SQLite adapter preserves readonly integer reads and online backup contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-adapter-"));
  const sourcePath = join(root, "source.sqlite");
  const backupPath = join(root, "backup.sqlite");
  const source = createDatabaseSync(sourcePath);
  try {
    source.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER, value TEXT)");
    source.exec("INSERT INTO records VALUES (9007199254740993, 'committed')");
    await backupDatabase(source, backupPath);
  } finally {
    source.close();
  }

  try {
    const backup = createDatabaseSync(backupPath, { readOnly: true });
    try {
      const statement = backup.prepare("SELECT id, value FROM records");
      statement.setReadBigInts(true);
      const row = statement.get();
      assert.equal(row?.id, 9007199254740993n);
      assert.equal(row?.value, "committed");
      assert.throws(() => backup.exec("INSERT INTO records VALUES (1, 'blocked')"));
    } finally {
      backup.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite adapter preserves busy error codes for startup lock retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-lock-adapter-"));
  const path = join(root, "tasks.sqlite");
  const owner = createDatabaseSync(path);
  const contender = createDatabaseSync(path);
  try {
    owner.exec("CREATE TABLE locks (value INTEGER); BEGIN IMMEDIATE");
    contender.exec("PRAGMA busy_timeout = 0");
    assert.throws(
      () => contender.exec("INSERT INTO locks VALUES (1)"),
      (error: unknown) => {
        if (!error || typeof error !== "object" || !("errcode" in error)) return false;
        const errcode = error.errcode;
        return typeof errcode === "number" && (errcode & 0xff) === 5;
      },
    );
  } finally {
    contender.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
