import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "./driver.js";

const desktopRequire = createRequire(new URL("../../../desktop/package.json", import.meta.url));
const currentNodeVersion = process.versions.node;

function probeLegacyBackend(): string | undefined {
  let database: { close(): void };
  try {
    const Better = desktopRequire("better-sqlite3") as new (path: string) => { close(): void };
    database = new Better(":memory:");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = "code" in error ? error.code : undefined;
    const missingModule =
      (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
      /^Cannot find (?:module|package) ['"]better-sqlite3['"]/.test(error.message);
    const missingBinding = /^Could not locate the bindings file\./.test(error.message);
    const unsupportedAbi =
      code === "ERR_DLOPEN_FAILED" &&
      /NODE_MODULE_VERSION|compiled against a different Node\.js version/.test(error.message);
    if (!missingModule && !missingBinding && !unsupportedAbi) throw error;
    return error.message.split("\n", 1)[0];
  }
  database.close();
  return undefined;
}

// 只探测真实 addon 的可用性一次；适配器执行错误绝不能被转成环境 skip。
const legacyUnavailable = probeLegacyBackend();
const legacyRuntimeLabel = legacyUnavailable
  ? `runtime 18.18.2 (UNVERIFIED real better-sqlite3 backend: ${legacyUnavailable})`
  : "runtime 18.18.2";
const resources: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of resources.splice(0)) if (db.isOpen) db.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
  vi.doUnmock("node:module");
  vi.resetModules();
});

async function loadDriver(version: string, failNative = false) {
  vi.resetModules();
  const loads: string[] = [];
  vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: version } });
  vi.doMock("node:module", () => ({
    createRequire: () => (name: string) => {
      loads.push(name);
      if (name === "node:sqlite" && failNative) throw new Error("native load failure");
      return desktopRequire(name);
    },
  }));
  // 必须在 runtime 版本与 require 边界注入后加载，静态 import 会提前固化驱动选择。
  return { driver: await import("./driver.js"), loads };
}

// 共享 Windows UT：通过版本注入验证两个驱动，不启动 Electron 或目标平台。
describe("SQLite driver boundary", () => {
  it.each([...new Set(["22.16.0", currentNodeVersion])])(
    "keeps native identities at complete-contract runtime %s without loading better-sqlite3",
    async (version) => {
      const { driver, loads } = await loadDriver(version);
      const native = desktopRequire("node:sqlite") as typeof driver;
      expect(driver.DatabaseSync).toBe(native.DatabaseSync);
      expect(driver.backup).toBe(native.backup);
      expect(loads).toEqual(["node:sqlite"]);
    },
  );

  it.each([...new Set(["22.16.0", currentNodeVersion])])(
    "never falls back after native module failure at %s",
    async (version) => {
      await expect(loadDriver(version, true)).rejects.toThrow("native load failure");
    },
  );

  it.each(["18.18.2", "22.15.0"])(
    "selects compatibility lazily below the complete-contract floor at %s",
    async (version) => {
      const { driver, loads } = await loadDriver(version);
      expect(loads).toEqual([]);
      const db = new driver.DatabaseSync(":memory:", { open: false, timeout: 321 });
      resources.push(db);
      expect(db.isOpen).toBe(false);
      expect(loads).toEqual([]);
    },
  );

  it.skipIf(Boolean(legacyUnavailable))(
    `${legacyRuntimeLabel}: preserves connection state with the real legacy backend`,
    async () => {
      const { driver, loads } = await loadDriver("18.18.2");
      const db = new driver.DatabaseSync(":memory:", { open: false, timeout: 321 });
      resources.push(db);
      db.open();
      expect(loads).toEqual(["better-sqlite3"]);
      expect(() => db.open()).toThrow();
      expect(db.prepare("pragma busy_timeout").get()).toMatchObject({ timeout: 321 });
      expect(db.prepare("pragma foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      db.exec("begin immediate");
      expect(db.isTransaction).toBe(true);
      db.exec("rollback");
      expect(db.isTransaction).toBe(false);
      db.close();
      expect(db.isOpen).toBe(false);
      expect(() => db.prepare("select 1")).toThrow();
    },
  );

  for (const version of [currentNodeVersion, "18.18.2"]) {
    const legacy = version === "18.18.2";
    const runtimeLabel = legacy ? legacyRuntimeLabel : `runtime ${version}`;
    describe.skipIf(legacy && Boolean(legacyUnavailable))(runtimeLabel, () => {
      it("exposes native errcode admission semantics for competing connections and SQL failures", async () => {
        const { driver } = await loadDriver(version);
        const directory = await mkdtemp(join(tmpdir(), "sqlite-driver-lock-"));
        directories.push(directory);
        const path = join(directory, "locked.sqlite");
        const owner = new driver.DatabaseSync(path, { timeout: 0 });
        const contender = new driver.DatabaseSync(path, { timeout: 0 });
        resources.push(owner, contender);
        owner.exec("create table locked(id integer primary key); insert into locked values(1)");
        const write = contender.prepare("insert into locked values(?)");
        owner.exec("begin immediate");
        try {
          for (const command of [() => contender.exec("begin immediate"), () => write.run(2)]) {
            let caught: unknown;
            try {
              command();
            } catch (error) {
              caught = error;
            }
            if (
              !(caught instanceof Error) ||
              !("errcode" in caught) ||
              typeof caught.errcode !== "number"
            ) {
              throw new Error("SQLite failure must retain Error and native numeric errcode", {
                cause: caught,
              });
            }
            expect(caught.errcode & 0xff).toBe(5);
            expect(caught.message).toMatch(/locked|busy/i);
          }
        } finally {
          owner.exec("rollback");
        }
        // 与启动 admission 一样只依赖 native errcode；释放锁后仍使用同一连接、同一 statement。
        expect(write.run(2).changes).toBe(1);
        expect(() => contender.prepare("select * from missing_table")).toThrow(
          expect.objectContaining({ errcode: 1 }),
        );
        expect(() => write.run(1)).toThrow(expect.objectContaining({ errcode: 1555 }));
        expect(Object.getPrototypeOf(contender.prepare("select * from locked").get())).toBeNull();
        expect(
          contender
            .prepare("select * from locked")
            .all()
            .every((row) => Object.getPrototypeOf(row) === null),
        ).toBe(true);
        expect(
          [...contender.prepare("select * from locked").iterate()].every(
            (row) => Object.getPrototypeOf(row) === null,
          ),
        ).toBe(true);
      });

      it("preserves positional/named bindings, integers, BLOB, NULL and iterator finalization", async () => {
        const { driver } = await loadDriver(version);
        const db = new driver.DatabaseSync(":memory:");
        resources.push(db);
        db.exec("create table sample(id integer primary key, value blob, label text)");
        expect(
          db.prepare("insert into sample values (?, ?, ?)").run(1, new Uint8Array([0, 255]), null)
            .changes,
        ).toBe(1);
        const row = db.prepare("select * from sample where id=@id").get({ "@id": 1 });
        expect(row?.label).toBeNull();
        expect(Array.from(row?.value as Uint8Array)).toEqual([0, 255]);
        const names = db.prepare(
          "select @x as a, $x as b, ? as c, '@ignored ?' as literal /* :ignored */",
        );
        expect(names.get({ "@x": 2, $x: 3 }, 4)).toMatchObject({
          a: 2,
          b: 3,
          c: 4,
          literal: "@ignored ?",
        });
        expect(() => db.prepare("select @id").get({ unexpected: 1 })).toThrow();
        const bare = db.prepare("select @id as id");
        expect(bare.get({ id: 1 })).toMatchObject({ id: 1 });
        bare.setAllowBareNamedParameters(false);
        expect(() => bare.get({ id: 1 })).toThrow();
        const large = db.prepare("select 9007199254740993 as n, 1.5 as real");
        expect(() => large.get()).toThrow(RangeError);
        large.setReadBigInts(true);
        expect(large.get()).toMatchObject({ n: 9007199254740993n, real: 1.5 });
        expect([...large.iterate()]).toHaveLength(1);
        const iterator = db.prepare("select * from sample").iterate();
        expect(iterator.next().done).toBe(false);
        iterator.return?.();
        db.exec("insert into sample values(2, null, 'after iterator')");
        expect(db.prepare("select * from sample").all()).toHaveLength(2);
      });

      it("performs asynchronous online WAL and attached backups with consumed options and read-only reopen", async () => {
        const { driver } = await loadDriver(version);
        const directory = await mkdtemp(join(tmpdir(), "sqlite-driver-boundary-"));
        directories.push(directory);
        const db = new driver.DatabaseSync(join(directory, "source.sqlite"));
        resources.push(db);
        db.exec(
          "pragma journal_mode=WAL; create table data(value text); insert into data values('wal row')",
        );
        const destination = join(directory, "snapshot.sqlite");
        const progress = vi.fn();
        const pending = driver.backup(db, destination, { rate: 1, progress });
        expect(pending).toBeInstanceOf(Promise);
        expect(await pending).toBeGreaterThan(0);
        expect(progress).toHaveBeenCalled();
        const copy = new driver.DatabaseSync(destination, { readOnly: true });
        resources.push(copy);
        expect(copy.prepare("select value from data").get()).toMatchObject({ value: "wal row" });
        expect(() => copy.exec("delete from data")).toThrow();
        db.prepare("attach database ? as extra").run(join(directory, "attached.sqlite"));
        db.exec(
          "create table extra.other(value text); insert into extra.other values('attached row')",
        );
        const attachedPath = join(directory, "attached-copy.sqlite");
        await driver.backup(db, attachedPath, { source: "extra", rate: 1 });
        const attached = new driver.DatabaseSync(attachedPath, { readOnly: true });
        resources.push(attached);
        expect(attached.prepare("select value from other").get()).toMatchObject({
          value: "attached row",
        });
        await expect(
          driver.backup(db, join(directory, "invalid.sqlite"), { source: "missing" }),
        ).rejects.toThrow();
        await expect(
          driver.backup(db, join(directory, "invalid-rate.sqlite"), { rate: 0 }),
        ).rejects.toThrow();
      });
    });
  }
});
