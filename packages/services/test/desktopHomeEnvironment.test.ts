import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSystemService } from "../src/system/systemService.js";
import { createSettingServiceWithMigrations } from "../src/setting/settingService.js";

// 开发/测试环境的显式 home 与 OMP 配置根保持独立。

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

test("OMP_CONFIG_ROOT 不覆盖 OmpCode 设置中的数据目录", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-home-settings-"));
  try {
    await mkdir(join(home, ".ompcode", "v2"), { recursive: true });
    await writeFile(
      join(home, ".ompcode", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: home }),
    );
    const { service } = createSettingServiceWithMigrations();
    await withEnv(
      { ZCODE_DESKTOP_HOME_DIR: home, OMP_CONFIG_ROOT: join(home, "omp-data") },
      async () => {
        const settings = await service.get();
        assert.equal(settings.dataBaseDir, home);
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
