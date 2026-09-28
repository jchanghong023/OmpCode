import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSystemService } from "../src/system/systemService.js";
import { createSettingServiceWithMigrations } from "../src/setting/settingService.js";

// CentOS 7 --home 链接语义的服务层纯逻辑（分支 931abda）：
// 启动器把数据根固定在外部目录（OMPCODE_CENTOS7_HOME），应用创建的默认/临时工作区
// 与系统信息展示的 home 都必须跟随覆盖；设置页不得把数据再迁回空间不足的原 HOME。

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

test("OMPCODE_CENTOS7_HOME 覆盖设置读取的 dataBaseDir，并锁定数据目录迁移目标", async () => {
  const home = await mkdtemp(join(tmpdir(), "centos7-home-settings-"));
  const externalHome = await mkdtemp(join(tmpdir(), "centos7-home-external-"));
  try {
    await mkdir(join(home, ".ompcode", "v2"), { recursive: true });
    await writeFile(
      join(home, ".ompcode", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: home }),
    );
    const { service } = createSettingServiceWithMigrations();

    await withEnv({ ZCODE_DESKTOP_HOME_DIR: home, OMPCODE_CENTOS7_HOME: undefined }, async () => {
      const settings = await service.get();
      assert.equal(settings.dataBaseDir, home);
    });

    await withEnv(
      { ZCODE_DESKTOP_HOME_DIR: home, OMPCODE_CENTOS7_HOME: externalHome },
      async () => {
        // --home 是本次启动的强制存储根：文件里的旧 dataBaseDir 不再生效。
        const settings = await service.get();
        assert.equal(settings.dataBaseDir, externalHome);
        // 设置页不能把数据迁回其它目录（含原 HOME）。
        await assert.rejects(service.updateDataBaseDir(home), /CentOS 7 --home/);
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(externalHome, { recursive: true, force: true });
  }
});

test("未设置 OMPCODE_CENTOS7_HOME 时不覆盖设置读取与迁移守卫", async () => {
  const home = await mkdtemp(join(tmpdir(), "centos7-home-off-"));
  try {
    await mkdir(join(home, ".ompcode", "v2"), { recursive: true });
    await writeFile(
      join(home, ".ompcode", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: home }),
    );
    const { service } = createSettingServiceWithMigrations();
    await withEnv({ ZCODE_DESKTOP_HOME_DIR: home, OMPCODE_CENTOS7_HOME: undefined }, async () => {
      const settings = await service.get();
      assert.equal(settings.dataBaseDir, home);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("system info 的 home 展示跟随 ZCODE_DESKTOP_HOME_DIR，SSH 等系统配置仍由原 HOME 读取", async () => {
  const home = await mkdtemp(join(tmpdir(), "centos7-home-sysinfo-"));
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
