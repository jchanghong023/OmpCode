import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../src/file/fileService.js";

test("application-created workspaces use the explicit desktop home", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-home-"));
  const previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  const fileService = createFileService();

  try {
    process.env.ZCODE_DESKTOP_HOME_DIR = home;
    const defaultWorkspace = await fileService.createDefaultWorkspace();
    const scratchWorkspace = await fileService.createScratchWorkspace({
      name: "scratch-home-test",
    });

    assert.equal(defaultWorkspace.path, join(home, "ZCodeProject"));
    assert.equal(scratchWorkspace.path, join(home, "ZCodeProject", "scratch-home-test"));
    assert.equal((await stat(scratchWorkspace.path)).isDirectory(), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
