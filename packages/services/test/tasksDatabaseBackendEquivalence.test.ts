import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backupDatabase,
  createDatabaseSync,
  type SqliteDatabase,
} from "../src/session/tasksDatabase/sqlite.js";

// Windows 当前运行时使用 node:sqlite；覆盖内存库、备份、事务与错误契约。
// 后端缺失应直接失败，不探测旧后端，也不把跳过计作通过。

/** 归一化 node:sqlite 的 null 原型行对象和 bigint，便于与约定快照比较。 */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return { __bigint: value.toString() };
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalize(entry),
      ]),
    );
  }
  return value;
}

interface BehaviorSnapshot {
  bigintValue: bigint | { __bigint: string };
  defaultNumber: number;
  namedParamRow: Record<string, unknown>;
  positionalRow: Record<string, unknown>;
  runResultChanges: number | bigint;
  runResultRowid: number | bigint;
  unicodeValue: string;
  inTransactionDuringBegin: boolean;
  inTransactionAfterRollback: boolean;
  allRowCount: number;
}

/** 在给定库上执行 Windows 数据行为脚本，返回可比较的快照。 */
function runBehaviorScript(database: SqliteDatabase): BehaviorSnapshot {
  database.exec(
    "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, n INTEGER);" +
      "INSERT INTO kv (k, v, n) VALUES ('big', 'committed', 9007199254740993);",
  );
  database.prepare("INSERT INTO kv (k, v, n) VALUES (@k, @v, @n)").run({
    k: "named",
    v: "héllo😀",
    n: 7,
  });
  database.prepare("INSERT INTO kv (k, v, n) VALUES (?, ?, ?)").run("positional", "plain", 9);

  const bigStatement = database.prepare("SELECT n FROM kv WHERE k = 'big'");
  bigStatement.setReadBigInts(true);
  const bigRow = bigStatement.get() as { n: bigint };
  // 默认读取只用安全整数；超精度整数会抛 RangeError，必须 setReadBigInts(true)。
  const defaultRow = database.prepare("SELECT n FROM kv WHERE k = 'positional'").get() as {
    n: number;
  };
  const namedParamRow = database
    .prepare("SELECT v, n FROM kv WHERE k = @k")
    .get({ k: "named" }) as Record<string, unknown>;
  const positionalRow = database
    .prepare("SELECT v, n FROM kv WHERE k = ?")
    .get("positional") as Record<string, unknown>;
  const insertResult = database
    .prepare("INSERT INTO kv (k, v, n) VALUES ('counted', 'x', 1)")
    .run();
  const unicodeValue = (
    database.prepare("SELECT v FROM kv WHERE k = 'named'").get() as { v: string }
  ).v;

  database.exec("BEGIN");
  const inTransactionDuringBegin = database.isTransaction;
  database.exec("ROLLBACK");
  const inTransactionAfterRollback = database.isTransaction;
  const allRowCount = database.prepare("SELECT k FROM kv").all().length;

  return {
    bigintValue: bigRow.n,
    defaultNumber: defaultRow.n,
    namedParamRow,
    positionalRow,
    runResultChanges: insertResult.changes,
    runResultRowid: insertResult.lastInsertRowid,
    unicodeValue,
    inTransactionDuringBegin,
    inTransactionAfterRollback,
    allRowCount,
  };
}

const expectedSnapshot: BehaviorSnapshot = {
  bigintValue: 9007199254740993n,
  defaultNumber: 9,
  namedParamRow: { v: "héllo😀", n: 7 },
  positionalRow: { v: "plain", n: 9 },
  runResultChanges: 1,
  runResultRowid: 4,
  unicodeValue: "héllo😀",
  inTransactionDuringBegin: true,
  inTransactionAfterRollback: false,
  allRowCount: 4,
};

test("[node:sqlite] 内存库数据行为与约定快照一致", () => {
  const database = createDatabaseSync(":memory:");
  try {
    const snapshot = runBehaviorScript(database);
    assert.deepEqual(normalize(snapshot), normalize(expectedSnapshot));
  } finally {
    database.close();
  }
});

test("[node:sqlite] 备份包含已提交内容且备份库只读生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-backend-"));
  const backupPath = join(root, "backup.sqlite");
  try {
    const source = createDatabaseSync(":memory:");
    try {
      source.exec("CREATE TABLE marks (id INTEGER); INSERT INTO marks VALUES (42)");
      await backupDatabase(source, backupPath);
    } finally {
      source.close();
    }
    const restored = createDatabaseSync(backupPath, { readOnly: true });
    try {
      const restoredRow = restored.prepare("SELECT id FROM marks").get();
      assert.equal(restoredRow?.id, 42);
      assert.throws(
        () => restored.exec("INSERT INTO marks VALUES (1)"),
        (error: unknown) => {
          return (
            error !== null &&
            typeof error === "object" &&
            "errcode" in error &&
            typeof error.errcode === "number" &&
            (error.errcode & 0xff) === 8
          );
        },
      );
    } finally {
      restored.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[node:sqlite] busy 竞争保留 SQLITE_BUSY 错误码供启动重试识别", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-busy-"));
  try {
    const path = join(root, "tasks.sqlite");
    const owner = createDatabaseSync(path);
    const contender = createDatabaseSync(path);
    try {
      owner.exec("CREATE TABLE locks (value INTEGER); BEGIN IMMEDIATE");
      contender.exec("PRAGMA busy_timeout = 0");
      assert.throws(
        () => contender.prepare("INSERT INTO locks VALUES (1)").run(),
        (error: unknown) => {
          return (
            error !== null &&
            typeof error === "object" &&
            "errcode" in error &&
            typeof error.errcode === "number" &&
            (error.errcode & 0xff) === 5
          );
        },
      );
    } finally {
      contender.close();
      owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[node:sqlite] 非数据库文件在首条语句时报 NOTADB", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-notadb-"));
  const path = join(root, "garbage.sqlite");
  try {
    await writeFile(path, "this is not a database, padding padding padding padding");
    assert.throws(
      () => {
        const database = createDatabaseSync(path);
        try {
          database.exec("CREATE TABLE attempts (a)");
        } finally {
          database.close();
        }
      },
      (error: unknown) => {
        return (
          error instanceof Error &&
          (!("errcode" in error) ||
            typeof error.errcode !== "number" ||
            (error.errcode & 0xff) === 26)
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[node:sqlite] 关闭后语句不可再用", () => {
  const database = createDatabaseSync(":memory:");
  const statement = database.prepare("SELECT 1 as one");
  database.close();
  assert.throws(() => statement.get());
});

test("[node:sqlite] 默认读取超精度整数抛 RangeError，大整数字段必须显式 bigint", () => {
  const database = createDatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE stamps (v INTEGER); INSERT INTO stamps VALUES (9007199254740993)");
    assert.throws(() => database.prepare("SELECT v FROM stamps").get(), RangeError);
    const safe = database.prepare("SELECT v FROM stamps");
    safe.setReadBigInts(true);
    const row = safe.get();
    assert.equal(row?.v, 9007199254740993n);
  } finally {
    database.close();
  }
});

test("backupDatabase 拒绝非本封装创建的库对象", async () => {
  const foreign = {
    exec() {},
    prepare() {
      throw new Error("unused");
    },
    close() {},
    isTransaction: false,
  };
  await assert.rejects(
    () => backupDatabase(foreign as unknown as SqliteDatabase, join(tmpdir(), "unused.sqlite")),
    TypeError,
  );
});
