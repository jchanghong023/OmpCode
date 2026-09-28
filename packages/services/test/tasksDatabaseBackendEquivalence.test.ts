import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  backupDatabase,
  createDatabaseSync,
  wrapBetterSqliteDatabase,
  type SqliteDatabase,
} from "../src/session/tasksDatabase/sqlite.js";

// 需求依据：centos7-release.md「Electron 选型」——sqlite 访问层必须双运行时可用：
// Windows/Electron 44（Node 22+）走 node:sqlite，CentOS 7/Electron 28（Node 18.18）走
// better-sqlite3，由同一封装模块按运行时选择驱动，数据行为两平台等价。
// 本文件用内存库/临时文件库覆盖：默认选择、强制后端注入、两后端行为一致与故障路径。

const FORCE_BACKEND_ENV = "OMP_CODE_SQLITE_FORCE_BACKEND";
type BackendName = "node:sqlite" | "better-sqlite3";

function probeBackend(backend: BackendName): boolean {
  const previous = process.env[FORCE_BACKEND_ENV];
  process.env[FORCE_BACKEND_ENV] = backend;
  try {
    const probe = createDatabaseSync(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  } finally {
    if (previous === undefined) delete process.env[FORCE_BACKEND_ENV];
    else process.env[FORCE_BACKEND_ENV] = previous;
  }
}

const backendAvailability: Record<BackendName, boolean> = {
  "node:sqlite": probeBackend("node:sqlite"),
  "better-sqlite3": probeBackend("better-sqlite3"),
};

async function withBackend<T>(backend: BackendName, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env[FORCE_BACKEND_ENV];
  process.env[FORCE_BACKEND_ENV] = backend;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[FORCE_BACKEND_ENV];
    else process.env[FORCE_BACKEND_ENV] = previous;
  }
}

function skipUnlessAvailable(t: TestContext, backend: BackendName): boolean {
  if (backendAvailability[backend]) return true;
  // 跳过必须显式给出原因（better-sqlite3 9.6.0 在 Node 24 无预编译且源码不兼容，
  // 见 docs/electron-44-28-api-compat.md），跳过不计为通过。
  t.skip(`后端 ${backend} 在当前运行时不可用（原生模块缺失或与 ABI 不符）`);
  return false;
}

/** 归一化两后端返回值：node:sqlite 行对象是 null 原型，bigint 需要可比表示。 */
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

/** 在给定库上执行同一段数据行为脚本，返回可跨后端比较的快照。 */
function runBehaviorScript(database: SqliteDatabase): BehaviorSnapshot {
  database.exec(
    "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT, n INTEGER);"
      + "INSERT INTO kv (k, v, n) VALUES ('big', 'committed', 9007199254740993);",
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
  // 默认（非 bigint）读取只用安全范围内的值：超精度整数默认读取是两后端已确认的行为差异
  // （node:sqlite 抛 RangeError），大整数字段必须 setReadBigInts(true)，另有单独用例固化。
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

for (const backend of ["node:sqlite", "better-sqlite3"] as const) {
  test(`[${backend}] 内存库数据行为与约定快照一致`, async (t) => {
    if (!skipUnlessAvailable(t, backend)) return;
    await withBackend(backend, () => {
      const database = createDatabaseSync(":memory:");
      try {
        const snapshot = runBehaviorScript(database);
        assert.deepEqual(normalize(snapshot), normalize(expectedSnapshot));
      } finally {
        database.close();
      }
    });
  });

  test(`[${backend}] 备份包含已提交内容且备份库只读生效`, async (t) => {
    if (!skipUnlessAvailable(t, backend)) return;
    const root = await mkdtemp(join(tmpdir(), "sqlite-backend-"));
    const backupPath = join(root, "backup.sqlite");
    try {
      await withBackend(backend, async () => {
        const source = createDatabaseSync(":memory:");
        try {
          source.exec("CREATE TABLE marks (id INTEGER); INSERT INTO marks VALUES (42)");
          await backupDatabase(source, backupPath);
        } finally {
          source.close();
        }
        const restored = createDatabaseSync(backupPath, { readOnly: true });
        try {
          assert.equal((restored.prepare("SELECT id FROM marks").get() as { id: number }).id, 42);
          assert.throws(() => restored.exec("INSERT INTO marks VALUES (1)"), (error: unknown) => {
            const errcode = (error as { errcode?: unknown }).errcode;
            return typeof errcode === "number" && (errcode & 0xff) === 8;
          });
        } finally {
          restored.close();
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`[${backend}] busy 竞争保留 SQLITE_BUSY 错误码供启动重试识别`, async (t) => {
    if (!skipUnlessAvailable(t, backend)) return;
    const root = await mkdtemp(join(tmpdir(), "sqlite-busy-"));
    try {
      await withBackend(backend, () => {
        const path = join(root, "tasks.sqlite");
        const owner = createDatabaseSync(path);
        const contender = createDatabaseSync(path);
        try {
          owner.exec("CREATE TABLE locks (value INTEGER); BEGIN IMMEDIATE");
          contender.exec("PRAGMA busy_timeout = 0");
          assert.throws(
            () => contender.prepare("INSERT INTO locks VALUES (1)").run(),
            (error: unknown) => {
              const errcode = (error as { errcode?: unknown }).errcode;
              return typeof errcode === "number" && (errcode & 0xff) === 5;
            },
          );
        } finally {
          contender.close();
          owner.close();
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`[${backend}] 非数据库文件在打开或首条语句时报 NOTADB`, async (t) => {
    if (!skipUnlessAvailable(t, backend)) return;
    const root = await mkdtemp(join(tmpdir(), "sqlite-notadb-"));
    const path = join(root, "garbage.sqlite");
    try {
      await writeFile(path, "this is not a database, padding padding padding padding");
      await withBackend(backend, () => {
        // node:sqlite 打开是惰性的（首条语句才报错），better-sqlite3 在构造时即报错；
        // 等价性要求是"打开+使用序列必须失败"，错误码一致而不是抛出时机一致。
        assert.throws(() => {
          const database = createDatabaseSync(path);
          try {
            database.exec("CREATE TABLE attempts (a)");
          } finally {
            database.close();
          }
        }, (error: unknown) => {
          const errcode = (error as { errcode?: unknown }).errcode;
          return typeof errcode !== "number" || (errcode & 0xff) === 26;
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`[${backend}] 关闭后语句不可再用`, async (t) => {
    if (!skipUnlessAvailable(t, backend)) return;
    await withBackend(backend, () => {
      const database = createDatabaseSync(":memory:");
      const statement = database.prepare("SELECT 1 as one");
      database.close();
      assert.throws(() => statement.get());
    });
  });
}

test("[node:sqlite] 默认读取超精度整数抛 RangeError（已确认的双后端差异，大整数字段必须显式 bigint）", async (t) => {
  if (!skipUnlessAvailable(t, "node:sqlite")) return;
  // 差异依据：node:sqlite 默认读取超过 Number.MAX_SAFE_INTEGER 的 INTEGER 抛 ERR_OUT_OF_RANGE；
  // better-sqlite3 默认返回不精确 number。等价性边界由此确立：所有可能超过 2^53 的列
  // （cookies.expires_utc、任务时间戳等）一律 setReadBigInts(true)，chromeCookieManager 已如此。
  await withBackend("node:sqlite", () => {
    const database = createDatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE stamps (v INTEGER); INSERT INTO stamps VALUES (9007199254740993)");
      assert.throws(() => database.prepare("SELECT v FROM stamps").get(), RangeError);
      const safe = database.prepare("SELECT v FROM stamps");
      safe.setReadBigInts(true);
      assert.equal((safe.get() as { v: bigint }).v, 9007199254740993n);
    } finally {
      database.close();
    }
  });
});

test("两后端同脚本行为快照一致（双后端可用时）", async (t) => {  for (const backend of ["node:sqlite", "better-sqlite3"] as const) {
    if (!backendAvailability[backend]) {
      t.diagnostic(
        `跳过 ${backend}：当前运行时不可用（better-sqlite3 9.6.0 无 Node 24 预编译且源码不兼容，`
          + "见 docs/electron-44-28-api-compat.md 的双 ABI 实测结论）",
      );
    }
  }
  if (!backendAvailability["node:sqlite"] || !backendAvailability["better-sqlite3"]) {
    t.skip("需要两个后端在当前运行时同时可加载才能做跨后端快照对比");
    return;
  }
  const snapshots: Partial<Record<BackendName, BehaviorSnapshot>> = {};
  for (const backend of ["node:sqlite", "better-sqlite3"] as const) {
    await withBackend(backend, () => {
      const database = createDatabaseSync(":memory:");
      try {
        snapshots[backend] = runBehaviorScript(database);
      } finally {
        database.close();
      }
    });
  }
  assert.deepEqual(
    normalize(snapshots["node:sqlite"]),
    normalize(snapshots["better-sqlite3"]),
    "两后端对同一脚本必须返回逐字段一致的数据",
  );
});

test("强制选择不可用后端时显式报错而不是静默换驱动", async (t) => {
  const unavailable = (["node:sqlite", "better-sqlite3"] as const).filter(
    (backend) => !backendAvailability[backend],
  );
  if (unavailable.length === 0) {
    t.skip("当前运行时两个后端都可用，无不可用后端可验证");
    return;
  }
  for (const backend of unavailable) {
    await withBackend(backend, () => {
      assert.throws(() => createDatabaseSync(":memory:"), (error: unknown) => {
        return error instanceof Error && error.message.includes(backend);
      });
    });
  }
});

test("better-sqlite3 适配层把原生语义映射到统一接口（桩实例）", () => {
  class StubBusyError extends Error {
    code = "SQLITE_BUSY";
  }
  let safeIntegersCalls: boolean[] = [];
  const recordedStatements: string[] = [];
  const raw = {
    inTransaction: true,
    lastExecSql: "",
    closed: false,
    exec(sql: string) {
      if (sql.includes("BUSY_TRAP")) throw new StubBusyError("database is locked");
      this.lastExecSql = sql;
    },
    prepare(sql: string) {
      if (sql.includes("BUSY_TRAP")) throw new StubBusyError("database is locked");
      recordedStatements.push(sql);
      return {
        all: (...bindings: unknown[]) => [{ k: bindings.length, proto: "stub" }],
        get: () => ({ got: true }),
        run: () => {
          if (sql.includes("BUSY_TRAP")) throw new StubBusyError("database is locked");
          return { changes: 2, lastInsertRowid: 5 };
        },
        safeIntegers(enabled?: boolean) {
          safeIntegersCalls.push(enabled ?? true);
        },
      };
    },
    close() {
      this.closed = true;
    },
    backup() {
      return Promise.resolve({});
    },
  };
  const database = wrapBetterSqliteDatabase(raw);
  const tracked = raw as unknown as { lastExecSql: string; closed: boolean };

  // isTransaction 读取旧版属性名 inTransaction。
  assert.equal(database.isTransaction, true);
  raw.inTransaction = false;
  assert.equal(database.isTransaction, false);

  // exec 原样转发且不吞 BUSY 语义：错误补 errcode=5 供 startup 锁等待识别。
  database.exec("CREATE TABLE t (a)");
  assert.equal(tracked.lastExecSql, "CREATE TABLE t (a)");
  assert.throws(() => database.exec("BUSY_TRAP"), (error: unknown) => {
    const errcode = (error as { errcode?: unknown }).errcode;
    return errcode === 5 && (error as { code?: string }).code === "SQLITE_BUSY";
  });

  // prepare/run/get/all 转发，setReadBigInts 映射 safeIntegers。
  const statement = database.prepare("SELECT ? ");
  assert.ok(recordedStatements.includes("SELECT ? "));
  assert.deepEqual(statement.get(1), { got: true });
  assert.deepEqual(statement.all(1, 2), [{ k: 2, proto: "stub" }]);
  assert.deepEqual(statement.run(), { changes: 2, lastInsertRowid: 5 });
  statement.setReadBigInts(true);
  statement.setReadBigInts(false);
  assert.deepEqual(safeIntegersCalls, [true, false]);
  assert.throws(() => database.prepare("INSERT INTO BUSY_TRAP"), (error: unknown) => {
    return (error as { errcode?: unknown }).errcode === 5;
  });

  // close 绑定原始实例。
  database.close();
  assert.equal(tracked.closed, true);
  safeIntegersCalls = [];
});

test("backupDatabase 拒绝非本封装创建的库对象", async () => {
  const foreign = { exec() {}, prepare() { throw new Error("unused"); }, close() {}, isTransaction: false };
  await assert.rejects(
    () => backupDatabase(foreign as unknown as SqliteDatabase, join(tmpdir(), "unused.sqlite")),
    TypeError,
  );
});
