import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDataBaseDir, setDataBaseDir } from "@zcode/services/node";
import { applyEarlyDataBaseDirBootstrap } from "../src/main/desktopDataBaseDirBootstrap.js";

test("CentOS 7 --home overrides a saved data directory during early bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "centos7-home-bootstrap-"));
  const settingsFile = join(root, "setting.json");
  const selectedHome = join(root, "selected-home");
  const previousHome = process.env.OMPCODE_CENTOS7_HOME;
  const previousBaseDir = getDataBaseDir();
  await writeFile(settingsFile, JSON.stringify({ dataBaseDir: join(root, "saved-home") }));

  try {
    process.env.OMPCODE_CENTOS7_HOME = selectedHome;
    assert.equal(applyEarlyDataBaseDirBootstrap(settingsFile), selectedHome);
    assert.equal(getDataBaseDir(), selectedHome);
  } finally {
    if (previousHome === undefined) {
      delete process.env.OMPCODE_CENTOS7_HOME;
    } else {
      process.env.OMPCODE_CENTOS7_HOME = previousHome;
    }
    setDataBaseDir(previousBaseDir);
    await rm(root, { recursive: true, force: true });
  }
});
