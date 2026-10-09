import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { createFileService } from "../src/file/fileService.js";
import {
  createFileMentionInputRounds,
  searchFileMentionEntries,
} from "../../ui/src/mentions/providers/fileMentionSearch.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext, names = ["a.ts", "b.ts"], ignore = "") {
  const root = await fs.mkdtemp(join(tmpdir(), "workspace-index-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("workspace-index-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(join(root, ".zcodeignore"), ignore);
  await Promise.all(names.map((name) => fs.writeFile(join(root, name), "export {};")));
  return root;
}

function trackIO(
  t: TestContext,
  afterReadDirectory?: (path: string) => Promise<void>,
  beforeIgnoreRead?: () => Promise<void>,
  beforeStat?: (path: string) => Promise<void>,
) {
  const original = { readdir: fs.readdir, readFile: fs.readFile, stat: fs.stat };
  const counts = { directories: new Map<string, number>(), ignoreReads: 0, stat: 0 };
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const path = String(args[0]);
    counts.directories.set(path, (counts.directories.get(path) ?? 0) + 1);
    const result = await original.readdir(...args);
    await afterReadDirectory?.(path);
    return result;
  });
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith(".zcodeignore")) {
      counts.ignoreReads++;
      await beforeIgnoreRead?.();
    }
    return original.readFile(...args);
  });
  t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    counts.stat++;
    await beforeStat?.(String(args[0]));
    return original.stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return counts;
}

test("same-scope ordinary and refresh queries share rule IO and one in-flight scan", async (t) => {
  const root = await fixture(t);
  const counts = trackIO(t);
  const service = createFileService();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.searchWorkspaceFiles({ rootPath: root, query: ".ts", refresh: index % 2 === 0 }),
    ),
  );
  for (const result of results)
    assert.deepEqual(
      result.map((entry) => entry.relativePath),
      ["a.ts", "b.ts"],
    );
  assert.equal(counts.directories.get(root), 1);
  assert.equal(counts.ignoreReads, 1);
  assert.equal(counts.stat, 1);
});

test("cached ordinary queries avoid rule read/compile, while explicit refresh discovers a new file", async (t) => {
  const root = await fixture(t);
  const counts = trackIO(t);
  const service = createFileService();
  for (let index = 0; index < 10; index++)
    assert.equal((await service.searchWorkspaceFiles({ rootPath: root, query: ".ts" })).length, 2);
  assert.equal(counts.directories.get(root), 1);
  assert.equal(counts.ignoreReads, 1);
  assert.equal(counts.stat, 10); // 保留外部规则修改后下一次使用立即核验的契约。
  await fs.writeFile(join(root, "zzzz-new-file.ts"), "export {};");
  assert.deepEqual(
    await service.searchWorkspaceFiles({ rootPath: root, query: "zzzz-new-file.ts" }),
    [],
  );
  const refreshed = await service.searchWorkspaceFiles({
    rootPath: root,
    query: "zzzz-new-file.ts",
    refresh: true,
  });
  assert.deepEqual(
    refreshed.map((entry) => entry.relativePath),
    ["zzzz-new-file.ts"],
  );
  assert.equal(counts.directories.get(root), 2);
  assert.equal(counts.ignoreReads, 1);
});

test("refresh arriving during a cached ordinary validation upgrades the shared request", async (t) => {
  const root = await fixture(t);
  const service = createFileService();
  await service.searchWorkspaceFiles({ rootPath: root, query: "" });
  await fs.writeFile(join(root, "zzzz-new-file.ts"), "export {};");
  const counts = trackIO(t);
  const [ordinary, refresh] = await Promise.all([
    service.searchWorkspaceFiles({ rootPath: root, query: "zzzz-new-file.ts" }),
    service.searchWorkspaceFiles({ rootPath: root, query: "zzzz-new-file.ts", refresh: true }),
  ]);
  assert.deepEqual(
    ordinary.map((entry) => entry.relativePath),
    ["zzzz-new-file.ts"],
  );
  assert.deepEqual(refresh, ordinary);
  assert.equal(counts.directories.get(root), 1);
  assert.equal(counts.ignoreReads, 0);
  assert.equal(counts.stat, 1);
});

test("actual mention lookup scans once per miss round; clear/reopen admits a new supplement", async (t) => {
  const root = await fixture(t);
  const counts = trackIO(t);
  const service = createFileService();
  const round = { didMissRefresh: false };
  for (let index = 1; index <= 30; index++) {
    const entries = await searchFileMentionEntries(
      service,
      {
        rootPath: root,
        query: "zzmissing".repeat(index),
      },
      round,
      () => true,
    );
    assert.deepEqual(entries, []);
  }
  assert.equal(counts.directories.get(root), 2);
  assert.equal(counts.ignoreReads, 1);
  assert.equal(counts.stat, 31);
  await fs.writeFile(join(root, "zzzz-created.ts"), "export {};");
  await searchFileMentionEntries(service, { rootPath: root, query: "" }, round, () => true);
  const created = await searchFileMentionEntries(
    service,
    {
      rootPath: root,
      query: "zzzz-created.ts",
    },
    round,
    () => true,
  );
  assert.deepEqual(
    created.map((entry) => entry.relativePath),
    ["zzzz-created.ts"],
  );
  assert.equal(counts.directories.get(root), 3);
  await fs.writeFile(join(root, "zzzz-reopened.ts"), "export {};");
  const reopened = await searchFileMentionEntries(
    service,
    {
      rootPath: root,
      query: "zzzz-reopened.ts",
    },
    { didMissRefresh: false },
    () => true,
  );
  assert.deepEqual(
    reopened.map((entry) => entry.relativePath),
    ["zzzz-reopened.ts"],
  );
  assert.equal(counts.directories.get(root), 4);
});

test("inactive mention requests do not consume the current round or trigger an extra refresh", async () => {
  let calls = 0;
  const round = { didMissRefresh: false };
  await searchFileMentionEntries(
    {
      searchWorkspaceFiles: async () => {
        calls++;
        return [];
      },
    },
    {
      rootPath: "scope",
      query: "missing",
    },
    round,
    () => false,
  );
  assert.equal(calls, 1);
  assert.equal(round.didMissRefresh, false);
});

test("accepted clear resets the round before delayed stat even when that clear becomes inactive", async (t) => {
  const root = await fixture(t);
  const captured = deferred();
  const release = deferred();
  let delayNextStat = false;
  const counts = trackIO(t, undefined, undefined, async () => {
    if (delayNextStat) {
      delayNextStat = false;
      captured.resolve();
      await release.promise;
    }
  });
  const service = createFileService();
  const round = { didMissRefresh: false };
  await searchFileMentionEntries(
    service,
    { rootPath: root, query: "zzmissing" },
    round,
    () => true,
  );
  assert.equal(round.didMissRefresh, true);
  await fs.writeFile(join(root, "zzzz-created.ts"), "export {};");
  delayNextStat = true;
  let emptyActive = true;
  const cleared = searchFileMentionEntries(
    service,
    { rootPath: root, query: "" },
    round,
    () => emptyActive,
  );
  assert.equal(round.didMissRefresh, false);
  await captured.promise;
  emptyActive = false;
  const next = searchFileMentionEntries(
    service,
    { rootPath: root, query: "zzzz-created.ts" },
    round,
    () => true,
  );
  release.resolve();
  await cleared;
  assert.deepEqual(
    (await next).map((entry) => entry.relativePath),
    ["zzzz-created.ts"],
  );
  assert.equal(counts.directories.get(root), 3);
});

test("raw input round admission keeps clears and reopenings even if deferred skips them", () => {
  const admission = createFileMentionInputRounds();
  const first = admission.admit("missing", true);
  assert.equal(admission.admit("missing-more", true), first);
  const cleared = admission.admit("", true);
  assert.equal(cleared, first + 1);
  assert.equal(admission.admit("new-file", true), cleared);
  assert.equal(admission.admit("new-file-more", true), cleared);
  assert.equal(admission.admit("", false), cleared);
  assert.equal(admission.admit("new-file", true), cleared + 1);
});

for (const fallback of ["gitignore", "builtin"] as const) {
  for (const recovery of ["ordinary", "refresh", "ttl"] as const) {
    test(`temporary ignore read EIO recovers ${fallback} fallback through ${recovery} without caching fallback index`, async (t) => {
      const root = await fixture(t, ["secret.ts", "public.ts", "fallback-only.ts"], "secret.ts\n");
      if (fallback === "gitignore")
        await fs.writeFile(join(root, ".gitignore"), "fallback-only.ts\n");
      let failOnce = true;
      const counts = trackIO(t, undefined, async () => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("Synthetic ignore read failure"), { code: "EIO" });
        }
      });
      const service = createFileService();
      const first = await service.searchWorkspaceFiles({ rootPath: root, query: "" });
      assert.ok(first.some((entry) => entry.relativePath === "secret.ts"));
      assert.equal(
        first.some((entry) => entry.relativePath === "fallback-only.ts"),
        fallback !== "gitignore",
      );
      if (recovery === "ttl") {
        const now = Date.now();
        t.mock.method(Date, "now", () => now + 60_001);
      }
      const recovered = await service.searchWorkspaceFiles({
        rootPath: root,
        query: "",
        refresh: recovery === "refresh",
      });
      assert.equal(
        recovered.some((entry) => entry.relativePath === "secret.ts"),
        false,
      );
      assert.ok(recovered.some((entry) => entry.relativePath === "public.ts"));
      assert.ok(recovered.some((entry) => entry.relativePath === "fallback-only.ts"));
      assert.deepEqual(
        await service.searchWorkspaceFiles({ rootPath: root, query: "" }),
        recovered,
      );
      assert.equal(counts.directories.get(root), 2);
      assert.equal(counts.ignoreReads, 2);
      assert.equal(counts.stat, 3);
    });
  }
}

test("external ignore edits invalidate the next ordinary query, including equal size and restored mtime", async (t) => {
  const root = await fixture(t, ["a.ts", "b.ts"], "a.ts\n");
  const ignorePath = join(root, ".zcodeignore");
  const fixedDate = new Date("2000-01-01T00:00:00.000Z");
  await fs.utimes(ignorePath, fixedDate, fixedDate);
  const counts = trackIO(t);
  const service = createFileService();
  const before = await service.searchWorkspaceFiles({ rootPath: root, query: "" });
  assert.deepEqual(
    before.map((entry) => entry.relativePath),
    ["b.ts"],
  );
  await fs.writeFile(ignorePath, "b.ts\n");
  await fs.utimes(ignorePath, fixedDate, fixedDate);
  const after = await service.searchWorkspaceFiles({ rootPath: root, query: "" });
  assert.deepEqual(
    after.map((entry) => entry.relativePath),
    ["a.ts"],
  );
  assert.equal(counts.directories.get(root), 2);
  assert.equal(counts.ignoreReads, 2);
});

test("saving rules during a delayed scan serializes the new generation and never commits the old index", async (t) => {
  const root = await fixture(t, ["a.ts", "b.ts"], "a.ts\n");
  const captured = deferred();
  const release = deferred();
  let held = false;
  const counts = trackIO(t, async (path) => {
    if (path === root && !held) {
      held = true;
      captured.resolve();
      await release.promise;
    }
  });
  const service = createFileService();
  const previous = service.searchWorkspaceFiles({ rootPath: root, query: "" });
  await captured.promise;
  await service.writeWorkspaceFileSearchIgnore({ rootPath: root, content: "b.ts\n" });
  const next = service.searchWorkspaceFiles({ rootPath: root, query: "", refresh: true });
  assert.equal(counts.directories.get(root), 1);
  release.resolve();
  assert.deepEqual(
    (await previous).map((entry) => entry.relativePath),
    ["b.ts"],
  );
  assert.deepEqual(
    (await next).map((entry) => entry.relativePath),
    ["a.ts"],
  );
  assert.deepEqual(
    (await service.searchWorkspaceFiles({ rootPath: root, query: "" })).map(
      (entry) => entry.relativePath,
    ),
    ["a.ts"],
  );
  assert.equal(counts.directories.get(root), 2);
});

test("rootPath changes under one identity wait for the old scan and do not accept its cache", async (t) => {
  const firstRoot = await fixture(t, ["first.ts"]);
  const nextRoot = await fixture(t, ["next.ts"]);
  const captured = deferred();
  const release = deferred();
  const counts = trackIO(t, async (path) => {
    if (path === firstRoot) {
      captured.resolve();
      await release.promise;
    }
  });
  const service = createFileService();
  const old = service.searchWorkspaceFiles({
    rootPath: firstRoot,
    workspaceIdentity: "remote",
    query: "",
  });
  await captured.promise;
  const next = service.searchWorkspaceFiles({
    rootPath: nextRoot,
    workspaceIdentity: "remote",
    query: "",
  });
  assert.equal(counts.directories.get(nextRoot), undefined);
  release.resolve();
  assert.deepEqual(
    (await old).map((entry) => entry.relativePath),
    ["first.ts"],
  );
  assert.deepEqual(
    (await next).map((entry) => entry.relativePath),
    ["next.ts"],
  );
  assert.deepEqual(
    (
      await service.searchWorkspaceFiles({
        rootPath: nextRoot,
        workspaceIdentity: "remote",
        query: "",
      })
    ).map((entry) => entry.relativePath),
    ["next.ts"],
  );
  assert.equal(counts.directories.get(nextRoot), 1);
});

test("same path different identities and different service instances keep separate indexes", async (t) => {
  const root = await fixture(t);
  const counts = trackIO(t);
  const first = createFileService();
  const second = createFileService();
  for (const identity of ["remote-a", "remote-b", " remote-a "])
    await first.searchWorkspaceFiles({ rootPath: root, workspaceIdentity: identity, query: "" });
  await second.searchWorkspaceFiles({ rootPath: root, workspaceIdentity: "remote-a", query: "" });
  assert.equal(counts.directories.get(root), 3);
  assert.equal(counts.ignoreReads, 3);
});

test("a failed directory scan clears in-flight admission and can be retried without a stale index", async (t) => {
  const root = await fixture(t);
  let failOnce = true;
  const counts = trackIO(t, async (path) => {
    if (path === root && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("Synthetic directory IO failure"), { code: "EIO" });
    }
  });
  const service = createFileService();
  await assert.rejects(
    service.searchWorkspaceFiles({ rootPath: root, query: "" }),
    /Synthetic directory IO failure/u,
  );
  const recovered = await service.searchWorkspaceFiles({ rootPath: root, query: "" });
  assert.deepEqual(
    recovered.map((entry) => entry.relativePath),
    ["a.ts", "b.ts"],
  );
  assert.equal(counts.directories.get(root), 2);
  assert.equal(counts.ignoreReads, 1);
});

test("index TTL rescans files while reusing unchanged rules; all completed cache state has LRU capacity", async (t) => {
  const root = await fixture(t);
  const counts = trackIO(t);
  const service = createFileService();
  let now = Date.now();
  // TTL 起点必须由同一受控时钟提供；真实首次扫描耗时会让“提前捕获 + 60 秒”仍未到期。
  t.mock.method(Date, "now", () => now);
  await service.searchWorkspaceFiles({ rootPath: root, workspaceIdentity: "oldest", query: "" });
  await fs.writeFile(join(root, "after-ttl.ts"), "export {};");
  now += 60_001;
  const afterTTL = await service.searchWorkspaceFiles({
    rootPath: root,
    workspaceIdentity: "oldest",
    query: "after-ttl",
  });
  assert.deepEqual(
    afterTTL.map((entry) => entry.relativePath),
    ["after-ttl.ts"],
  );
  assert.equal(counts.directories.get(root), 2);
  assert.equal(counts.ignoreReads, 1);
  for (let index = 0; index < 4; index++)
    await service.searchWorkspaceFiles({
      rootPath: root,
      workspaceIdentity: `other-${index}`,
      query: "",
    });
  assert.equal(counts.directories.get(root), 6);
  await service.searchWorkspaceFiles({ rootPath: root, workspaceIdentity: "oldest", query: "" });
  assert.equal(counts.directories.get(root), 7);
  assert.equal(counts.ignoreReads, 6);
  await service.searchWorkspaceFiles({ rootPath: root, workspaceIdentity: "other-3", query: "" });
  assert.equal(counts.directories.get(root), 7);
});

test("performance evidence: 30 miss prefixes on 20 directories / 1000 real files", async (t) => {
  const root = await fixture(t, []);
  for (let directory = 0; directory < 20; directory++) {
    const path = join(root, `dir-${directory}`);
    await fs.mkdir(path);
    await Promise.all(
      Array.from({ length: 50 }, (_, file) =>
        fs.writeFile(join(path, `file-${file}.ts`), "export {};"),
      ),
    );
  }
  const counts = trackIO(t);
  const service = createFileService();
  const round = { didMissRefresh: false };
  const started = performance.now();
  for (let query = 1; query <= 30; query++) {
    assert.deepEqual(
      await searchFileMentionEntries(
        service,
        {
          rootPath: root,
          query: "zzmissing".repeat(query),
          limit: 5,
        },
        round,
        () => true,
      ),
      [],
    );
  }
  t.diagnostic(
    JSON.stringify({
      node: process.version,
      scenario: "30 miss prefixes / 20 dirs / 1000 files",
      scans: counts.directories.get(root),
      readdir: [...counts.directories.values()].reduce((sum, count) => sum + count, 0),
      ignoreReads: counts.ignoreReads,
      stat: counts.stat,
      ms: performance.now() - started,
    }),
  );
  assert.equal(counts.directories.get(root), 2);
  assert.equal(
    [...counts.directories.values()].reduce((sum, count) => sum + count, 0),
    42,
  );
  assert.equal(counts.ignoreReads, 1);
  assert.equal(counts.stat, 31);
});
