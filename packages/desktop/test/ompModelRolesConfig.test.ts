import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readOmpModelRolesConfig,
  resolveOmpModelRolesConfigPath,
  writeOmpModelRolesConfig,
} from "../src/main/ompModelRolesConfig.js";

test("配置路径与 omp 的 PI_CONFIG_DIR 主目录解析规则一致", () => {
  const home = join(tmpdir(), "omp-home");
  assert.equal(resolveOmpModelRolesConfigPath(home, {}), join(home, ".omp", "agent", "config.yml"));
  assert.equal(
    resolveOmpModelRolesConfigPath(home, { PI_CONFIG_DIR: "../shared-omp" }),
    join(resolve(home, "../shared-omp"), "agent", "config.yml"),
  );
  assert.equal(
    resolveOmpModelRolesConfigPath(home, { OMP_PROFILE: "work" }),
    join(home, ".omp", "profiles", "work", "agent", "config.yml"),
  );
  assert.equal(
    resolveOmpModelRolesConfigPath(home, { OMP_PROFILE: "", PI_PROFILE: "legacy" }),
    join(home, ".omp", "agent", "config.yml"),
  );
});

test("modelRoles 保存保留注释、其他角色和字段，重复保存不备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-config-"));
  const configPath = join(dir, "config.yml");
  const original = [
    "# account config",
    "modelRoles:",
    "  default: commandcode/old # keep this comment",
    "  task: [provider/one, provider/two]",
    "otherSetting: true # untouched",
    "",
  ].join("\n");
  try {
    await writeFile(configPath, original);
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: true,
      roles: [
        { role: "default", value: "commandcode/old" },
        { role: "task", value: "provider/one,provider/two" },
      ],
    });
    const saved = await writeOmpModelRolesConfig(configPath, [
      { role: "default", value: "commandcode/inclusionai/ling-3.0-flash-sante:free" },
    ]);
    assert.equal(saved.success, true);
    if (!saved.success) return;
    assert.equal(await readFile(saved.backupPath!, "utf8"), original);
    const updated = await readFile(configPath, "utf8");
    assert.match(
      updated,
      /default: commandcode\/inclusionai\/ling-3\.0-flash-sante:free # keep this comment/u,
    );
    assert.match(updated, /task: \[provider\/one, provider\/two\]/u);
    assert.match(updated, /otherSetting: true # untouched/u);
    const savedAgain = await writeOmpModelRolesConfig(configPath, [
      { role: "default", value: "commandcode/inclusionai/ling-3.0-flash-sante:free" },
    ]);
    assert.deepEqual(savedAgain, { success: true });
    assert.equal((await readdir(dir)).filter((name) => name.includes(".bak-")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无配置或无效 YAML 时不写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-config-"));
  const configPath = join(dir, "config.yml");
  try {
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: false,
      error: "omp_config_missing",
    });
    await writeFile(configPath, "modelRoles: [\n");
    assert.deepEqual(
      await writeOmpModelRolesConfig(configPath, [{ role: "default", value: "provider/model" }]),
      {
        success: false,
        error: "omp_config_parse_failed",
      },
    );
    assert.equal(await readFile(configPath, "utf8"), "modelRoles: [\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
