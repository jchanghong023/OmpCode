import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getAppConfigDir,
  getTasksIndexDatabasePath,
  getConversationWorkspaceDir,
} from "../src/paths.js";
import { createSystemService } from "../src/system/systemService.js";
import { createSettingServiceWithMigrations } from "../src/setting/settingService.js";

// 开发/测试 home 不改写系统 HOME；生产应用根优先跟随 OMP_CONFIG_ROOT。

async function withEnv(
  env: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("OMP_CONFIG_ROOT 派生应用根，设置读写与显示路径同源且不能由 UI 迁移", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-home-settings-"));
  const ompRoot = join(home, "omp-data");
  const appRoot = `${ompRoot}_ompcode`;
  const legacySettings = join(home, ".ompcode", "v2", "setting.json");
  const activeSettings = join(appRoot, "v2", "setting.json");
  try {
    await mkdir(join(home, ".ompcode", "v2"), { recursive: true });
    await writeFile(
      legacySettings,
      JSON.stringify({
        dataBaseDir: home,
        locale: "en-US",
        lastActiveTaskByWorkspace: { old: "old-id" },
      }),
    );
    const original = await readFile(legacySettings, "utf8");
    await withEnv(
      {
        ZCODE_DESKTOP_HOME_DIR: home,
        OMP_CONFIG_ROOT: ompRoot,
      },
      async () => {
        const { service } = createSettingServiceWithMigrations();
        const settings = await service.get();
        assert.equal(settings.locale, "zh-CN");
        assert.equal(settings.localePreference, "system");
        assert.equal(settings.dataStoragePath, appRoot);
        assert.equal(settings.dataBaseDir, undefined);
        assert.equal(settings.lastActiveTaskByWorkspace, undefined);
        await service.update({ locale: "zh-CN" });
        assert.equal((await service.get()).locale, "zh-CN");
        const persisted = JSON.parse(await readFile(activeSettings, "utf8"));
        assert.equal(persisted.dataStoragePath, undefined);
        assert.equal(persisted.locale, "zh-CN");
        assert.equal(getAppConfigDir(), join(appRoot, "v2"));
        assert.ok(getTasksIndexDatabasePath().startsWith(join(appRoot, "v2")));
        assert.equal(getConversationWorkspaceDir(), join(appRoot, "workspace", "default"));
        await assert.rejects(service.updateDataBaseDir(join(home, "another")), /OMP_CONFIG_ROOT/);
        assert.equal(await readFile(legacySettings, "utf8"), original);
        await service.update({ locale: "en-US", localePreference: "system" });
        const restored = await createSettingServiceWithMigrations().service.get();
        assert.equal(restored.locale, "en-US");
        assert.equal(restored.localePreference, "system");
      },
    );
    await withEnv(
      {
        ZCODE_DESKTOP_HOME_DIR: home,
        OMP_CONFIG_ROOT: undefined,
      },
      async () => {
        const { service } = createSettingServiceWithMigrations();
        const saved = await service.get();
        assert.equal(saved.locale, "en-US");
        assert.equal(saved.localePreference, "en-US");
        await assert.rejects(service.updateDataBaseDir(join(home, "another")), /OMP_CONFIG_ROOT/);
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("system info 的 home 展示跟随 ZCODE_DESKTOP_HOME_DIR，SSH 等系统配置仍由原 HOME 读取", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-home-sysinfo-"));
  try {
    const overridden = await createSystemService({ env: { ZCODE_DESKTOP_HOME_DIR: home } }).info();
    assert.equal(overridden.homedir, home);
    assert.equal(overridden.platform, process.platform);

    const fallback = await createSystemService({ env: {} }).info();
    assert.equal(fallback.homedir, homedir());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
