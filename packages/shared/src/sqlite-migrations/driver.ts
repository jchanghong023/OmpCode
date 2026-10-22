import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { PathLike } from "node:fs";

export type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLOutputValue>;
type Bindings = (SQLInputValue | Record<string, SQLInputValue>)[];
export interface StatementSync {
  all(...parameters: Bindings): Row[];
  get(...parameters: Bindings): Row | undefined;
  run(...parameters: Bindings): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...parameters: Bindings): IterableIterator<Row>;
  setReadBigInts(enabled: boolean): void;
  setAllowBareNamedParameters(enabled: boolean): void;
  setAllowUnknownNamedParameters(enabled: boolean): void;
  readonly sourceSQL: string;
}
export interface DatabaseSyncOptions {
  open?: boolean;
  readOnly?: boolean;
  enableForeignKeyConstraints?: boolean;
  timeout?: number;
  readBigInts?: boolean;
  allowBareNamedParameters?: boolean;
  allowUnknownNamedParameters?: boolean;
}
export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
}
export interface BackupOptions {
  source?: string;
  target?: string;
  rate?: number;
  progress?: (info: { totalPages: number; remainingPages: number }) => void;
}
type Constructor = new (path: PathLike, options?: DatabaseSyncOptions) => DatabaseSync;
interface BetterStatement {
  readonly reader: boolean;
  safeIntegers(enabled: boolean): BetterStatement;
  all(parameters: Record<string, SQLInputValue>): Row[];
  get(parameters: Record<string, SQLInputValue>): Row | undefined;
  iterate(parameters: Record<string, SQLInputValue>): IterableIterator<Row>;
  run(parameters: Record<string, SQLInputValue>): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}
interface BetterDatabase {
  open: boolean;
  inTransaction: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): BetterStatement;
  close(): unknown;
  backup(
    path: string,
    options: {
      attached: string;
      progress(info: { totalPages: number; remainingPages: number }): number;
    },
  ): Promise<{ totalPages: number; remainingPages: number }>;
}
type BetterConstructor = new (
  path: string,
  options: { readonly: boolean; timeout: number },
) => BetterDatabase;
const require = createRequire(import.meta.url);
let betterConstructor: BetterConstructor | undefined;
function pathString(path: PathLike): string {
  return path instanceof URL
    ? fileURLToPath(path)
    : typeof path === "string"
      ? path
      : path.toString();
}
function integer(value: SQLOutputValue, bigInts: boolean): SQLOutputValue {
  if (typeof value !== "bigint" || bigInts) return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw Object.assign(
      new RangeError(`Value is too large to be represented as a JavaScript number: ${value}`),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  return Number(value);
}

// 两个驱动的具名参数规则不同；只重写 SQL 参数 token，不触碰字符串、标识符和注释。
function parameters(sql: string): { sql: string; slots: (string | number)[] } {
  const slots: (string | number)[] = [];
  const names = new Map<string, number>();
  let anonymous = 0;
  return {
    sql: sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[@:$][\w\u0080-\uFFFF]+|\?(?:\d+)?/g,
      (token) => {
        if (!/^[@:$?]/.test(token)) return token;
        let index = token === "?" ? undefined : names.get(token);
        if (index === undefined) {
          index = slots.length;
          if (token[0] === "?") {
            const position = token.length === 1 ? anonymous : Number(token.slice(1)) - 1;
            if (position < 0 || position >= 32766)
              throw new RangeError("Invalid SQLite parameter index");
            slots.push(position);
            anonymous = Math.max(anonymous, position + 1);
          } else {
            slots.push(token);
          }
          if (token !== "?") names.set(token, index);
        }
        return `:__zcode_${index}`;
      },
    ),
    slots,
  };
}

const sqlitePrimaryCodes: Readonly<Record<string, number>> = {
  ERROR: 1,
  INTERNAL: 2,
  PERM: 3,
  ABORT: 4,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  CORRUPT: 11,
  NOTFOUND: 12,
  FULL: 13,
  CANTOPEN: 14,
  PROTOCOL: 15,
  EMPTY: 16,
  SCHEMA: 17,
  TOOBIG: 18,
  CONSTRAINT: 19,
  MISMATCH: 20,
  MISUSE: 21,
  NOLFS: 22,
  AUTH: 23,
  FORMAT: 24,
  RANGE: 25,
  NOTADB: 26,
  NOTICE: 27,
  WARNING: 28,
  ROW: 100,
  DONE: 101,
};
const sqliteExtendedCodes: Readonly<Record<string, number>> = {
  SQLITE_BUSY_RECOVERY: 261,
  SQLITE_BUSY_SNAPSHOT: 517,
  SQLITE_BUSY_TIMEOUT: 773,
  SQLITE_LOCKED_SHAREDCACHE: 262,
  SQLITE_LOCKED_VTAB: 518,
  SQLITE_CONSTRAINT_CHECK: 275,
  SQLITE_CONSTRAINT_COMMITHOOK: 531,
  SQLITE_CONSTRAINT_FOREIGNKEY: 787,
  SQLITE_CONSTRAINT_FUNCTION: 1043,
  SQLITE_CONSTRAINT_NOTNULL: 1299,
  SQLITE_CONSTRAINT_PRIMARYKEY: 1555,
  SQLITE_CONSTRAINT_TRIGGER: 1811,
  SQLITE_CONSTRAINT_UNIQUE: 2067,
  SQLITE_CONSTRAINT_VTAB: 2323,
  SQLITE_CONSTRAINT_ROWID: 2579,
  SQLITE_CONSTRAINT_PINNED: 2835,
  SQLITE_CONSTRAINT_DATATYPE: 3091,
};
function throwSqliteError(error: unknown): never {
  // 启动 admission 依赖原生 errcode 的低八位识别锁竞争；只补 SQLite 错误本身，不替换 cause/stack 或吞错。
  if (
    error instanceof Error &&
    error.name === "SqliteError" &&
    "code" in error &&
    typeof error.code === "string" &&
    !("errcode" in error)
  ) {
    const code = sqliteExtendedCodes[error.code] ?? sqlitePrimaryCodes[error.code.split("_")[1]!];
    if (code !== undefined)
      Object.defineProperty(error, "errcode", {
        value: code,
        configurable: true,
        enumerable: true,
      });
  }
  throw error;
}

class CompatibleStatement implements StatementSync {
  private readonly statement: BetterStatement;
  private readonly slots: (string | number)[];
  private bigInts: boolean;
  private bare: boolean;
  private unknown: boolean;
  constructor(
    db: BetterDatabase,
    readonly sourceSQL: string,
    options: DatabaseSyncOptions,
  ) {
    const compiled = parameters(sourceSQL);
    this.slots = compiled.slots;
    try {
      this.statement = db.prepare(compiled.sql).safeIntegers(true);
    } catch (error) {
      throwSqliteError(error);
    }
    this.bigInts = options.readBigInts ?? false;
    this.bare = options.allowBareNamedParameters ?? true;
    this.unknown = options.allowUnknownNamedParameters ?? false;
  }
  private bind(args: Bindings): Record<string, SQLInputValue> {
    const first = args[0];
    const named =
      first !== null && typeof first === "object" && !ArrayBuffer.isView(first) ? first : undefined;
    const positional = named ? args.slice(1) : args;
    const result: Record<string, SQLInputValue> = {};
    const consumed = new Set<string>();
    let count = 0;
    for (const [index, slot] of this.slots.entries()) {
      let value: SQLInputValue | undefined = null;
      if (typeof slot === "number") {
        value = slot < positional.length ? (positional[slot] as SQLInputValue | undefined) : null;
        count = Math.max(count, slot + 1);
      } else if (named) {
        const bare = slot.slice(1);
        if (this.bare && Object.hasOwn(named, bare)) {
          if (
            this.slots.some(
              (other) => typeof other === "string" && other !== slot && other.slice(1) === bare,
            )
          ) {
            throw new Error(
              `Cannot create bare named parameter '${bare}' because of conflicting names`,
            );
          }
          value = named[bare]!;
          consumed.add(bare);
        }
        if (Object.hasOwn(named, slot)) {
          value = named[slot]!;
          consumed.add(slot);
        }
      }
      // ?? 会把显式 undefined 吞成 NULL；只给缺失参数补 NULL，非法绑定保持原生 TypeError/code。
      if (value === undefined) {
        throw Object.assign(new TypeError("Provided value cannot be bound to SQLite parameter"), {
          code: "ERR_INVALID_ARG_TYPE",
        });
      }
      // node:sqlite 接受所有 TypedArray/DataView，better-sqlite3 只接受 Buffer。
      result[`__zcode_${index}`] = ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : value;
    }
    if (positional.length > count) throw new RangeError("Too many parameter values were provided");
    if (named && !this.unknown) {
      for (const key of Object.keys(named))
        if (!consumed.has(key)) throw new Error(`Unknown named parameter '${key}'`);
    }
    return result;
  }
  private row(row: Row): Row {
    for (const key of Object.keys(row)) {
      const value = integer(row[key]!, this.bigInts);
      // 原生返回 Uint8Array；只建同一 BLOB 内存的视图，不复制字节或泄露 Buffer 专有 API。
      row[key] = Buffer.isBuffer(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value;
    }
    Object.setPrototypeOf(row, null);
    return row;
  }
  all(...args: Bindings): Row[] {
    try {
      const bindings = this.bind(args);
      if (!this.statement.reader) {
        this.statement.run(bindings);
        return [];
      }
      return this.statement.all(bindings).map((row) => this.row(row));
    } catch (error) {
      throwSqliteError(error);
    }
  }
  get(...args: Bindings): Row | undefined {
    try {
      const bindings = this.bind(args);
      if (!this.statement.reader) {
        this.statement.run(bindings);
        return undefined;
      }
      const row = this.statement.get(bindings);
      return row === undefined ? undefined : this.row(row);
    } catch (error) {
      throwSqliteError(error);
    }
  }
  *iterate(...args: Bindings): IterableIterator<Row> {
    try {
      const bindings = this.bind(args);
      if (!this.statement.reader) {
        this.statement.run(bindings);
        return;
      }
      for (const row of this.statement.iterate(bindings)) yield this.row(row);
    } catch (error) {
      throwSqliteError(error);
    }
  }
  run(...args: Bindings): { changes: number | bigint; lastInsertRowid: number | bigint } {
    try {
      const result = this.statement.run(this.bind(args));
      return {
        changes: integer(result.changes, this.bigInts) as number | bigint,
        lastInsertRowid: integer(result.lastInsertRowid, this.bigInts) as number | bigint,
      };
    } catch (error) {
      throwSqliteError(error);
    }
  }
  setReadBigInts(enabled: boolean): void {
    this.bigInts = enabled;
  }
  setAllowBareNamedParameters(enabled: boolean): void {
    this.bare = enabled;
  }
  setAllowUnknownNamedParameters(enabled: boolean): void {
    this.unknown = enabled;
  }
}

class CompatibleDatabase implements DatabaseSync {
  private handle: BetterDatabase | undefined;
  private readonly path: string;
  constructor(
    path: PathLike,
    private readonly options: DatabaseSyncOptions = {},
  ) {
    this.path = pathString(path);
    if (options.open !== false) this.open();
  }
  private connection(): BetterDatabase {
    if (!this.handle?.open) throw new Error("database is not open");
    return this.handle;
  }
  get isOpen(): boolean {
    return this.handle?.open ?? false;
  }
  get isTransaction(): boolean {
    return this.connection().inTransaction;
  }
  open(): void {
    if (this.isOpen) throw new Error("database is already open");
    // 仅旧 runtime 真正打开连接时加载 native addon，Windows 原生路径不解析其 binding。
    betterConstructor ??= require("better-sqlite3") as BetterConstructor;
    let db: BetterDatabase;
    try {
      db = new betterConstructor(this.path, {
        readonly: this.options.readOnly ?? false,
        timeout: this.options.timeout ?? 0,
      });
    } catch (error) {
      throwSqliteError(error);
    }
    try {
      db.exec(
        `PRAGMA foreign_keys = ${this.options.enableForeignKeyConstraints === false ? "OFF" : "ON"}`,
      );
    } catch (error) {
      db.close();
      throwSqliteError(error);
    }
    this.handle = db;
  }
  close(): void {
    try {
      this.connection().close();
    } catch (error) {
      throwSqliteError(error);
    }
  }
  exec(sql: string): void {
    try {
      this.connection().exec(sql);
    } catch (error) {
      throwSqliteError(error);
    }
  }
  prepare(sql: string): StatementSync {
    try {
      return new CompatibleStatement(this.connection(), sql, this.options);
    } catch (error) {
      throwSqliteError(error);
    }
  }
  async onlineBackup(path: PathLike, options: BackupOptions = {}): Promise<number> {
    if (options.target !== undefined && options.target !== "main")
      throw new Error(`unknown database ${options.target}`);
    const rate = options.rate ?? 100;
    if (!Number.isInteger(rate) || rate < 1 || rate > 2147483647)
      throw new RangeError("backup rate must be a positive int32");
    try {
      const result = await this.connection().backup(pathString(path), {
        attached: options.source ?? "main",
        progress(info) {
          options.progress?.(info);
          return rate;
        },
      });
      options.progress?.(result);
      return result.totalPages;
    } catch (error) {
      throwSqliteError(error);
    }
  }
}

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
// 22.5 只有模块入口；backup/isTransaction/timeout 到 22.16 才齐备（主线为 24.0）。
// 不假定已停止维护的 23.x 具备这些 24.0 能力；版本选择后加载错误仍直接抛出，绝不换驱动。
const native =
  major >= 24 || (major === 22 && minor >= 16)
    ? (require("node:sqlite") as {
        DatabaseSync: Constructor;
        backup: (source: DatabaseSync, path: PathLike, options?: BackupOptions) => Promise<number>;
      })
    : undefined;
export const DatabaseSync: Constructor = native?.DatabaseSync ?? CompatibleDatabase;
export const backup: (
  source: DatabaseSync,
  path: PathLike,
  options?: BackupOptions,
) => Promise<number> = native
  ? native.backup
  : (source, path, options) => (source as CompatibleDatabase).onlineBackup(path, options);
