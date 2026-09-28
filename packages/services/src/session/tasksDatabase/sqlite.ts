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

// 变更依据：better-sqlite3 按运行时 ABI 单独编译（CentOS 7 发布流水线用 Electron 28 header 现场编译，
// Node 24/Electron 44 时代 header 无对应二进制且源码不兼容，见 docs/electron-44-28-api-compat.md）。
// 原实现在模块加载期 require，会让无该二进制的开发运行时直接阻断 sqlite.ts 导入；改为首次使用时
// 加载，把"缺后端"的故障路径集中到 createDatabaseSync 内显式报错。
let betterSqliteModule: BetterSqliteConstructor | undefined;
let betterSqliteLoadState: "unloaded" | "loaded" | "failed" = "unloaded";
function loadBetterSqlite(): BetterSqliteConstructor | undefined {
  if (betterSqliteLoadState === "unloaded") {
    betterSqliteLoadState = "failed";
    try {
      betterSqliteModule = require("better-sqlite3") as BetterSqliteConstructor;
      betterSqliteLoadState = "loaded";
    } catch {
      // 原生二进制缺失或与当前 ABI 不符：保持 undefined，由 createDatabaseSync 报缺后端错误。
    }
  }
  return betterSqliteModule;
}

/** UT 注入点：强制后端选择；生产不设置该变量，维持 node:sqlite 优先、better-sqlite3 回退的默认序。 */
const FORCE_BACKEND_ENV = "OMP_CODE_SQLITE_FORCE_BACKEND";

function resolveBackend(): "node:sqlite" | "better-sqlite3" {
  const forced = process.env[FORCE_BACKEND_ENV];
  if (forced === "node:sqlite") {
    if (!nativeSqlite) {
      throw new Error(`${FORCE_BACKEND_ENV}=node:sqlite 但当前运行时未提供内置 node:sqlite`);
    }
    return "node:sqlite";
  }
  if (forced === "better-sqlite3") {
    if (!loadBetterSqlite()) {
      throw new Error(
        `${FORCE_BACKEND_ENV}=better-sqlite3 但 better-sqlite3 原生模块不可用（缺失或与当前 ABI 不符）`,
      );
    }
    return "better-sqlite3";
  }
  return nativeSqlite ? "node:sqlite" : "better-sqlite3";
}

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
  if (resolveBackend() === "node:sqlite") {
    const database = new nativeSqlite!.DatabaseSync(path, options);
    backends.set(database, { backend: "node:sqlite", raw: database });
    return database;
  }

  const betterSqlite = loadBetterSqlite();
  if (!betterSqlite) {
    throw new Error(
      "无可用 SQLite 后端：当前运行时无内置 node:sqlite，且 better-sqlite3 原生模块加载失败",
    );
  }
  // 修复依据：better-sqlite3 会拒绝 readonly: undefined；未指定时使用默认读写模式。
  const raw =
    options.readOnly === undefined
      ? new betterSqlite(path)
      : new betterSqlite(path, { readonly: options.readOnly });
  const database = wrapBetterSqliteDatabase(raw);
  backends.set(database, { backend: "better-sqlite3", raw });
  return database;
}

/**
 * 把 better-sqlite3 实例包装成统一 SqliteDatabase 接口。
 * 单独导出仅供 UT 以桩实例验证适配层映射；生产路径一律经 createDatabaseSync。
 *
 * @lintignore UT 注入用
 */
export function wrapBetterSqliteDatabase(raw: BetterDatabase): SqliteDatabase {
  return {
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
