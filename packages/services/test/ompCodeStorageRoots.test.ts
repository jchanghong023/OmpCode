import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveStorageRoots } from "../src/storage/adapters/rootsResolver.js";

test("存储管理使用实际应用根，不嵌套 .ompcode 或扫描旧根", () => {
  const homeDir = join(tmpdir(), "storage-home");
  const dataRootDir = join(homeDir, "omp-data_ompcode");
  assert.deepEqual(resolveStorageRoots({ homeDir, dataBaseDir: dataRootDir, dataRootDir }), [
    { id: "dataBaseDir", path: dataRootDir, hasCustomDataBaseDir: true },
  ]);
  assert.deepEqual(
    resolveStorageRoots({ homeDir, dataBaseDir: homeDir, dataRootDir: join(homeDir, ".ompcode") }),
    [{ id: "home", path: join(homeDir, ".ompcode"), hasCustomDataBaseDir: false }],
  );
});
