import { createRequire } from "node:module";

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  all(...bindings: unknown[]): Array<Record<string, unknown>>;
  get(...bindings: unknown[]): Record<string, unknown> | undefined;
  run(...bindings: unknown[]): SqliteRunResult;
  setReadBigInts(enabled: boolean): void;
}

export interface SqliteDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDatabaseOptions {
  readOnly?: boolean;
}

type NativeStatement = SqliteStatement;
interface NativeDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}
interface NativeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NativeDatabase;
  backup(source: NativeDatabase, destination: string): Promise<void>;
}
interface BetterStatement extends SqliteStatement {
  safeIntegers(enabled?: boolean): void;
}
interface BetterDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): BetterStatement;
  close(): void;
  backup(destination: string): Promise<unknown>;
}
interface BetterSqliteConstructor {
  new (path: string, options?: { readonly?: boolean }): BetterDatabase;
}

function preserveBusyErrorCode<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error && typeof error === "object") {
      const value = error as { code?: unknown; errcode?: unknown };
      if (
        typeof value.errcode !== "number" &&
        typeof value.code === "string" &&
        value.code.startsWith("SQLITE_BUSY")
      ) {
        try {
          Object.assign(error, { errcode: 5 });
        } catch {
          // 无法补充诊断字段时仍抛出原始 SQLite 异常。
        }
      }
    }
    throw error;
  }
}

const require = createRequire(import.meta.url);
let nativeSqlite: NativeSqliteModule | undefined;
try {
  nativeSqlite = require("node:sqlite") as NativeSqliteModule;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
}
const betterSqlite = nativeSqlite
  ? undefined
  : (require("better-sqlite3") as BetterSqliteConstructor);
const backends = new WeakMap<
  SqliteDatabase,
  | { backend: "node:sqlite"; raw: NativeDatabase }
  | { backend: "better-sqlite3"; raw: BetterDatabase }
>();

/** Node 24 使用内置 SQLite；旧版运行时加载随应用暂存的原生模块。 */
export function createDatabaseSync(
  path: string,
  options: SqliteDatabaseOptions = {},
): SqliteDatabase {
  if (nativeSqlite) {
    const database = new nativeSqlite.DatabaseSync(path, options);
    backends.set(database, { backend: "node:sqlite", raw: database });
    return database;
  }

  // 修复依据：better-sqlite3 会拒绝 readonly: undefined；未指定时使用默认读写模式。
  const raw =
    options.readOnly === undefined
      ? new betterSqlite!(path)
      : new betterSqlite!(path, { readonly: options.readOnly });
  const database: SqliteDatabase = {
    // 修复依据：迁移异常时只在活动事务内回滚；旧版后端对应属性名为 inTransaction。
    get isTransaction() {
      return raw.inTransaction;
    },
    exec: (sql) => preserveBusyErrorCode(() => raw.exec(sql)),
    prepare(sql) {
      const statement = preserveBusyErrorCode(() => raw.prepare(sql));
      return {
        all: (...bindings) => preserveBusyErrorCode(() => statement.all(...bindings)),
        get: (...bindings) => preserveBusyErrorCode(() => statement.get(...bindings)),
        run: (...bindings) => preserveBusyErrorCode(() => statement.run(...bindings)),
        setReadBigInts: (enabled) => statement.safeIntegers(enabled),
      };
    },
    close: raw.close.bind(raw),
  };
  backends.set(database, { backend: "better-sqlite3", raw });
  return database;
}

/** 两种后端均执行 SQLite 在线备份，包含已提交的 WAL 内容。 */
export async function backupDatabase(source: SqliteDatabase, destination: string): Promise<void> {
  const opened = backends.get(source);
  if (!opened) throw new TypeError("Database was not created by createDatabaseSync");
  if (opened.backend === "node:sqlite") {
    await nativeSqlite!.backup(opened.raw, destination);
  } else {
    await (opened.raw as BetterDatabase).backup(destination);
  }
}
