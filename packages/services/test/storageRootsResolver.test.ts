import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StorageUsageSnapshot } from "@zcode/shared";
import {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "../src/storage/adapters/rootsResolver.js";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";
import { runStorageScan } from "../src/storage/adapters/inProcessScanRunner.js";
import { createStorageService } from "../src/storage/app/storageService.js";

const tempHomes: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** 同时记录目录和文件内容，不能只证明某个哨兵文件尚存。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relativePath: string): Promise<void> {
    for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result[`${path}/`] = "";
        await visit(path);
      } else {
        result[path] = (await readFile(join(root, path))).toString("base64");
      }
    }
  }
  await visit("");
  return result;
}

describe("resolveStorageRoots", () => {
  it("uses the complete application root once without appending a legacy directory", () => {
    const dataBaseDir = join(tmpdir(), "ompcode-root", "..");
    expect(resolveStorageRoots({ dataBaseDir })).toEqual([
      { id: "dataBaseDir", path: resolve(dataBaseDir), hasCustomDataBaseDir: false },
    ]);
  });

  it.each(["default", "environment"] as const)(
    "scans and cleans only the actual %s application root, preserving upstream trees",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "ompcode-storage-home-"));
      tempHomes.push(home);
      const nativeRoot = join(home, "native-config");
      const applicationRoot = mode === "default" ? join(home, ".ompcode") : `${nativeRoot}_ompcode`;
      vi.stubEnv("HOME", home);
      vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
      vi.stubEnv("OMP_CONFIG_ROOT", mode === "default" ? "" : nativeRoot);
      // paths 在启动导入时固定环境；测试也从真实启动路径所有者取得根，不伪造 resolver 参数。
      vi.resetModules();
      const { getDataBaseDir } = await import("../src/paths.js");
      const upstreamFiles = {
        "cli/rollout/model-io-upstream.jsonl": "upstream rollout must survive",
        "cli/agents/sess_old/worker/transcript.jsonl": "upstream transcript must survive",
        "v2/setting.json": '{"dataBaseDir":"/legacy"}',
        "empty-marker/keep.txt": "upstream tree",
      };
      const upstream = join(home, ".zcode");
      await seed(upstream, upstreamFiles);
      await mkdir(join(upstream, "empty-directory"));
      await seed(nativeRoot, { "sessions/native.jsonl": "native OMP history" });
      const upstreamBefore = await snapshotTree(upstream);
      const nativeBefore = await snapshotTree(nativeRoot);
      const trajectoryPath = "cli/rollout/model-io-app.jsonl";
      const transcriptPath = "cli/agents/sess_old/worker/transcript.jsonl";
      const appFiles = {
        [trajectoryPath]: "app trajectory",
        [transcriptPath]: "app transcript",
        "v2/setting.json": "app settings",
        "cli/artifacts/keep.txt": "tool artifact",
      };
      await seed(applicationRoot, appFiles);
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(join(applicationRoot, transcriptPath), old, old);
      const service = createStorageService({
        roots: createStorageRootsResolver({ getDataBaseDir }),
        scanRunner: { run: runStorageScan },
        cleaner: createFsStorageCleaner(),
        progressThrottleMs: 0,
      });
      try {
        const {
          promise: completed,
          resolve: resolveSnapshot,
          reject,
        } = Promise.withResolvers<StorageUsageSnapshot>();
        service.onScanProgress((snapshot) => {
          if (snapshot.status === "complete") resolveSnapshot(snapshot);
          if (snapshot.status === "failed") reject(new Error(JSON.stringify(snapshot.errors)));
        });
        await service.startScan();
        const scanned = await completed;
        expect(scanned.errors).toEqual([]);
        expect(scanned.roots).toHaveLength(1);
        const usage = scanned.roots[0]!;
        expect(usage).toMatchObject({
          id: "dataBaseDir",
          path: applicationRoot,
          fileCount: Object.keys(appFiles).length,
          bytes: Object.values(appFiles).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        });
        expect(
          usage.categories.find((category) => category.id === "modelTrajectory"),
        ).toMatchObject({
          fileCount: 1,
          bytes: Buffer.byteLength(appFiles[trajectoryPath]),
        });
        expect(
          usage.categories.find((category) => category.id === "subagentTranscripts"),
        ).toMatchObject({
          fileCount: 1,
          bytes: Buffer.byteLength(appFiles[transcriptPath]),
        });
        await expect(
          service.clean({ rootId: "home", categoryId: "modelTrajectory" }),
        ).rejects.toThrow("storage root not available: home");
        for (const [categoryId, file] of [
          ["modelTrajectory", trajectoryPath],
          ["subagentTranscripts", transcriptPath],
        ] as const) {
          expect(await service.clean({ rootId: "dataBaseDir", categoryId })).toMatchObject({
            deletedCount: 1,
            freedBytes: Buffer.byteLength(appFiles[file]),
            failures: [],
          });
          await expect(readFile(join(applicationRoot, file))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(await readFile(join(applicationRoot, "v2/setting.json"), "utf8")).toBe(
          "app settings",
        );
        expect(await readFile(join(applicationRoot, "cli/artifacts/keep.txt"), "utf8")).toBe(
          "tool artifact",
        );
        expect(await snapshotTree(upstream)).toEqual(upstreamBefore);
        expect(await snapshotTree(nativeRoot)).toEqual(nativeBefore);
      } finally {
        service.dispose();
      }
    },
  );
});
