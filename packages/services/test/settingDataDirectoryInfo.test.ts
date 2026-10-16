import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveOfflineDataRoots } from "@zcode/shared/node";
import type { DataDirectoryInfo, ISettingService } from "../src/index.js";
import { getZCodeDataRootDir } from "../src/paths.js";
import { createSettingService } from "../src/setting/settingService.js";

for (const offline of ["0", "on"]) {
  test(`setting directory contract returns actual roots without loading settings (OMP_OFFLINE=${offline})`, async (t) => {
    const oldConfigRoot = process.env.OMP_CONFIG_ROOT;
    const oldOffline = process.env.OMP_OFFLINE;
    t.after(() => {
      if (oldConfigRoot === undefined) delete process.env.OMP_CONFIG_ROOT;
      else process.env.OMP_CONFIG_ROOT = oldConfigRoot;
      if (oldOffline === undefined) delete process.env.OMP_OFFLINE;
      else process.env.OMP_OFFLINE = oldOffline;
    });
    const configRoot = join(tmpdir(), "omp-settings-directory-contract");
    process.env.OMP_CONFIG_ROOT = configRoot;
    process.env.OMP_OFFLINE = offline;

    const settingService: ISettingService = createSettingService();
    const info: DataDirectoryInfo = await settingService.getDataDirectoryInfo();
    const persistentRoot = `${configRoot}_ompcode`;
    assert.equal(info.runtimeRoot, getZCodeDataRootDir());
    assert.equal(info.persistentRoot, persistentRoot);
    assert.equal(info.offline, offline === "on" && process.platform === "linux");
    if (info.offline) {
      assert.equal(
        info.runtimeRoot,
        resolveOfflineDataRoots(persistentRoot, "ompcode")?.runtimeRoot,
      );
      assert.notEqual(info.runtimeRoot, info.persistentRoot);
    } else {
      assert.equal(info.runtimeRoot, info.persistentRoot);
    }
  });
}
