import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { transform } from "esbuild";
import { createFileService } from "../src/file/fileService.js";
import { searchFileMentionEntries } from "../../ui/src/mentions/providers/fileMentionSearch.js";

// 用指定 Git 基线重建改前服务入口；不覆盖 checkout，也不保留旧产品源码副本。
const baselineRef = process.argv[2];
assert.ok(
  baselineRef,
  "Usage: pnpm exec tsx packages/services/test/workspaceFileIndex.perf.mts <baseline-git-ref>",
);
const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const sourcePath = resolve(repository, "packages/services/src/file/fileService.ts");
const { stdout: shaOutput } = await execute(
  "git",
  ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`],
  { cwd: repository },
);
const baselineSha = shaOutput.trim();
const { stdout: source } = await execute(
  "git",
  ["show", `${baselineSha}:packages/services/src/file/fileService.ts`],
  { cwd: repository },
);
// 相对依赖解析到当前实现。该入口的扫描/缓存改动全部在基线 fileService 内；匹配和规则语义依赖保持不变。
const relocated = source.replace(/from\s+["']([^"']+)["']/gu, (_, specifier: string) => {
  const url = specifier.startsWith(".")
    ? pathToFileURL(resolve(dirname(sourcePath), specifier.replace(/\.js$/u, ".ts"))).href
    : specifier.startsWith("@zcode/")
      ? import.meta.resolve(specifier)
      : specifier;
  return `from ${JSON.stringify(url)}`;
});
const compiled = await transform(relocated, { loader: "ts", format: "esm", target: "node24" });
const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "workspace-file-index-perf-"));
const baselinePath = join(temporaryRoot, "baseline.mjs");
const workspaceRoot = join(temporaryRoot, "fixture");
const original = { readdir: fs.readdir, readFile: fs.readFile, stat: fs.stat };

async function measure(optimized: boolean, baselineCreate: typeof createFileService) {
  const counts = { scans: 0, readdir: 0, ignoreReads: 0, stat: 0 };
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    counts.readdir++;
    if (String(args[0]) === workspaceRoot) counts.scans++;
    return original.readdir(...args);
  }) as typeof fs.readdir;
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith(".zcodeignore")) counts.ignoreReads++;
    return original.readFile(...args);
  }) as typeof fs.readFile;
  fs.stat = (async (...args: Parameters<typeof fs.stat>) => {
    counts.stat++;
    return original.stat(...args);
  }) as typeof fs.stat;
  syncBuiltinESMExports();
  const service = optimized ? createFileService() : baselineCreate();
  const round = { didMissRefresh: false };
  const started = performance.now();
  try {
    for (let query = 1; query <= 30; query++) {
      const params = { rootPath: workspaceRoot, query: "zzmissing".repeat(query), limit: 5 };
      if (optimized) {
        assert.deepEqual(await searchFileMentionEntries(service, params, round, () => true), []);
      } else {
        // 改前 UI 对每个不同的无命中前缀发普通查询再发 refresh。
        assert.deepEqual(await service.searchWorkspaceFiles(params), []);
        assert.deepEqual(await service.searchWorkspaceFiles({ ...params, refresh: true }), []);
      }
    }
    return { ...counts, ms: performance.now() - started };
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
}

try {
  await fs.writeFile(baselinePath, compiled.code);
  const baseline = (await import(pathToFileURL(baselinePath).href)) as {
    createFileService: typeof createFileService;
  };
  await fs.mkdir(workspaceRoot);
  await fs.writeFile(join(workspaceRoot, ".zcodeignore"), "excluded/\n");
  for (let directory = 0; directory < 20; directory++) {
    const path = join(workspaceRoot, `dir-${directory}`);
    await fs.mkdir(path);
    await Promise.all(
      Array.from({ length: 50 }, (_, file) =>
        fs.writeFile(join(path, `file-${file}.ts`), "export {};"),
      ),
    );
  }
  const before = [];
  const after = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    before.push(await measure(false, baseline.createFileService));
    after.push(await measure(true, baseline.createFileService));
  }
  const median = (values: { ms: number }[]) =>
    values.map((value) => value.ms).sort((left, right) => left - right)[1];
  console.log(
    JSON.stringify({
      node: process.version,
      baselineSha,
      scenario: "30 sequential miss prefixes / 20 directories / 1000 real files",
      storage: "local temporary filesystem; not CentOS 7/network disk acceptance",
      before,
      after,
      medianMs: { before: median(before), after: median(after) },
    }),
  );
} finally {
  Object.assign(fs, original);
  syncBuiltinESMExports();
  // 仅删除当前 mkdtemp 返回的独占测试目录；不触及用户 workspace 或会话。
  assert.equal(dirname(temporaryRoot), resolve(tmpdir()));
  assert.ok(basename(temporaryRoot).startsWith("workspace-file-index-perf-"));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
