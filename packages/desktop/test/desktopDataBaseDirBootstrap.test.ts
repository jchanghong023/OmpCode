import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDataBaseDir, setDataBaseDir } from "@zcode/services/node";
import { applyEarlyDataBaseDirBootstrap } from "../src/main/desktopDataBaseDirBootstrap.js";

test("OMP_CONFIG_ROOT does not override the saved OmpCode data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-data-bootstrap-"));
  const settingsFile = join(root, "setting.json");
  const ompRoot = join(root, "omp-root");
  const savedHome = join(root, "saved-home");
  const previousRoot = process.env.OMP_CONFIG_ROOT;
  const previousBaseDir = getDataBaseDir();
  await writeFile(settingsFile, JSON.stringify({ dataBaseDir: savedHome }));

  try {
    process.env.OMP_CONFIG_ROOT = ompRoot;
    assert.equal(applyEarlyDataBaseDirBootstrap(settingsFile), savedHome);
    assert.equal(getDataBaseDir(), savedHome);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.OMP_CONFIG_ROOT;
    } else {
      process.env.OMP_CONFIG_ROOT = previousRoot;
    }
    setDataBaseDir(previousBaseDir);
    await rm(root, { recursive: true, force: true });
  }
});
