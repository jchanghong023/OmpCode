import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { createWorkspaceFileIndexCache } from "../src/file/workspaceFileIndex.js";
import { defaultWorkspaceFileSearchFilter } from "../src/file/workspaceFileMentionFilter.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

const logger: ServiceLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

type ReadDirectory = (
  path: Parameters<typeof fs.readdir>[0],
  options: { withFileTypes: true },
) => Promise<Dirent[]>;

function instrumentReaddir(t: TestContext, wrap: (read: ReadDirectory) => ReadDirectory) {
  const original = fs.readdir as unknown as ReadDirectory;
  const mocked = t.mock.method(fs, "readdir", wrap(original) as unknown as typeof fs.readdir);
  // 修改 builtin 默认对象后同步命名导出，真实扫描仍调用原生 readdir，只增加受控等待。
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "workspace-file-index-"));
  const root = join(base, "workspace");
  await mkdir(root);
  await writeFile(join(root, ".zcodeignore"), "ignored/\n*.log\n");
  return { base, root };
}

function paths(packed: string, root: string) {
  return unpackWorkspaceFileEntries(packed, root).map((entry) => entry.relativePath);
}

test("offline scheduler fills eight slots and preserves complete sorted, ignored and symlink results", async (t) => {
  const { base, root } = await fixture();
  try {
    const expected = ["root.ts", "linked", ".hidden/visible.ts"];
    await writeFile(join(root, "root.ts"), "root");
    await writeFile(join(root, ".env"), "secret");
    await writeFile(join(root, "native.so"), "binary");
    await writeFile(join(root, "excluded.log"), "ignored");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "excluded.ts"), "ignored subtree");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, ".hidden", "visible.ts"), "visible file");
    await mkdir(join(base, "external"));
    await writeFile(join(base, "external", "not-traversed.ts"), "outside workspace");
    await symlink(
      join(base, "external"),
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (let index = 0; index < 12; index++) {
      const branch = `branch-${index}`;
      await mkdir(join(root, branch, "deep"), { recursive: true });
      await writeFile(join(root, branch, "main.ts"), "branch");
      await writeFile(join(root, branch, "deep", `item-${index}.ts`), "deep");
      expected.push(
        branch,
        `${branch}/deep`,
        `${branch}/main.ts`,
        `${branch}/deep/item-${index}.ts`,
      );
    }

    let active = 0;
    let peak = 0;
    const reads: string[] = [];
    instrumentReaddir(t, (read) => async (path, options) => {
      reads.push(String(path));
      active++;
      peak = Math.max(peak, active);
      try {
        await setImmediate();
        return await read(path, options);
      } finally {
        active--;
      }
    });
    const env = { OMP_OFFLINE: " yes " };
    const offline = createWorkspaceFileIndexCache(defaultWorkspaceFileSearchFilter, logger, {
      env,
      platform: "linux",
    });
    // 门禁只在实例创建时读取，后续环境变化不能切换已存在实例的调度方式。
    env.OMP_OFFLINE = "0";
    const result = await offline.ensure(root);
    assert.equal(peak, 8);
    assert.equal(active, 0);
    assert.equal(reads.length, 26);
    assert.equal(new Set(reads).size, reads.length, "each directory is admitted once");
    assert.ok(!reads.includes(join(root, "ignored")));
    assert.ok(!reads.includes(join(root, "linked")));
    assert.deepEqual(paths(result.packed, root).sort(), expected.sort());
    assert.equal(
      unpackWorkspaceFileEntries(result.packed, root).find(
        (entry) => entry.relativePath === "linked",
      )?.type,
      "directory",
    );

    for (const [platform, value] of [
      ["linux", "0"],
      ["linux", "false"],
      ["linux", ""],
      ["win32", "true"],
      ["darwin", "1"],
    ] as const) {
      peak = 0;
      reads.length = 0;
      const normal = createWorkspaceFileIndexCache(defaultWorkspaceFileSearchFilter, logger, {
        platform,
        env: { OMP_OFFLINE: value },
      });
      assert.equal((await normal.ensure(root)).packed, result.packed);
      assert.equal(peak, 1, `${platform}/${value} must retain original serial traversal`);
      assert.equal(active, 0);
      assert.equal(reads.length, 26);
      assert.equal(new Set(reads).size, reads.length);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("offline and normal instances retain filter, workspace identity, refresh and root isolation", async () => {
  const { base, root } = await fixture();
  try {
    const otherRoot = join(base, "other");
    await mkdir(otherRoot);
    await writeFile(join(otherRoot, ".zcodeignore"), "");
    await writeFile(join(otherRoot, "other.ts"), "other root");
    await writeFile(join(root, "visible.ts"), "first");
    for (const value of ["true", "false"]) {
      const cache = createWorkspaceFileIndexCache(defaultWorkspaceFileSearchFilter, logger, {
        platform: "linux",
        env: { OMP_OFFLINE: value },
      });
      const first = await cache.ensure(root, " identity-a ");
      const added = `added-${value}.ts`;
      await writeFile(join(root, added), "new file");
      assert.equal(await cache.ensure(root, "identity-a"), first, "trimmed identity shares cache");
      assert.ok(paths((await cache.ensure(root, "identity-b")).packed, root).includes(added));
      assert.ok(paths((await cache.ensure(root, "identity-a", true)).packed, root).includes(added));
      assert.deepEqual(paths((await cache.ensure(otherRoot, "identity-a")).packed, otherRoot), [
        "other.ts",
      ]);
      const filtered = createWorkspaceFileIndexCache(
        {
          evaluate(entry, context) {
            return entry.name === "visible.ts"
              ? { include: false, traverse: false }
              : defaultWorkspaceFileSearchFilter.evaluate(entry, context);
          },
        },
        logger,
        { platform: "linux", env: { OMP_OFFLINE: value } },
      );
      assert.ok(!paths((await filtered.ensure(root)).packed, root).includes("visible.ts"));
      assert.ok(
        paths((await cache.ensure(root, "identity-a")).packed, root).includes("visible.ts"),
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test(
  "offline fatal failure stops admission and drains active reads before rejecting merged requests",
  { timeout: 10_000 },
  async (t) => {
    const { base, root } = await fixture();
    const releaseFailure = deferred();
    const failureThrown = deferred();
    const allStarted = deferred();
    const releaseReads = deferred();
    const fatal = new Error("fatal controlled readdir failure");
    let outcome: Promise<unknown> | undefined;
    try {
      const queuedNames = Array.from({ length: 4 }, (_, index) => `queued-${index}`);
      const slowNames = Array.from({ length: 7 }, (_, index) => `slow-${index}`);
      for (const name of [...queuedNames, ...slowNames, "fatal"]) {
        await mkdir(join(root, name, "discovered-later"), { recursive: true });
        await writeFile(join(root, name, "result.ts"), "active result");
      }
      let active = 0;
      let startedSlow = 0;
      let settled = false;
      let evaluated = 0;
      const reads: string[] = [];
      instrumentReaddir(t, (read) => async (path, options) => {
        const directory = String(path);
        reads.push(directory);
        active++;
        try {
          if (directory === root) {
            const entries = await read(path, options);
            const order = [...queuedNames, ...slowNames, "fatal"];
            return entries.sort(
              (left, right) => order.indexOf(left.name) - order.indexOf(right.name),
            );
          }
          if (basename(directory) === "fatal") {
            await releaseFailure.promise;
            failureThrown.resolve();
            throw fatal;
          }
          startedSlow++;
          if (startedSlow === 7) allStarted.resolve();
          await releaseReads.promise;
          return await read(path, options);
        } finally {
          active--;
        }
      });
      const cache = createWorkspaceFileIndexCache(
        {
          evaluate(entry, context) {
            evaluated++;
            return defaultWorkspaceFileSearchFilter.evaluate(entry, context);
          },
        },
        logger,
        { platform: "linux", env: { OMP_OFFLINE: "on" } },
      );
      const scan = cache.ensure(root, "identity");
      assert.equal(
        cache.ensure(root, "identity", true),
        scan,
        "refresh joins the in-flight generation",
      );
      outcome = scan.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await allStarted.promise;
      assert.equal(active, 8);
      releaseFailure.resolve();
      await failureThrown.promise;
      await setImmediate();
      assert.equal(active, 7);
      assert.equal(settled, false, "fatal failure must wait for the seven active readers");
      assert.equal(reads.length, 9, "root plus eight admitted children only");
      releaseReads.resolve();
      assert.equal(await outcome, fatal);
      assert.equal(active, 0);
      assert.equal(
        reads.length,
        9,
        "neither queued nor newly discovered directories start after failure",
      );
      const afterRejection = evaluated;
      await setImmediate();
      assert.equal(evaluated, afterRejection, "no scan work mutates results after rejection");
    } finally {
      releaseFailure.resolve();
      releaseReads.resolve();
      await outcome;
      await rm(base, { recursive: true, force: true });
    }
  },
);
