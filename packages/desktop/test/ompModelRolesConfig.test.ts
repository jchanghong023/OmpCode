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
  assert.equal(
    resolveOmpModelRolesConfigPath(home, {
      OMP_CONFIG_ROOT: "~/data",
      PI_CONFIG_DIR: "ignored",
      OMP_PROFILE: "work",
    }),
    join(home, "data", "profiles", "work", "agent", "config.yml"),
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

test("首次配置从空角色创建当前 profile 的 config.yml，重复保存不产生备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-config-"));
  const configPath = join(dir, "profiles", "work", "agent", "config.yml");
  try {
    assert.deepEqual(await readOmpModelRolesConfig(configPath), { success: true, roles: [] });
    assert.deepEqual(
      await writeOmpModelRolesConfig(configPath, [
        { role: "default", value: "provider/model:free" },
      ]),
      { success: true },
    );
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: true,
      roles: [{ role: "default", value: "provider/model:free" }],
    });
    assert.match(
      await readFile(configPath, "utf8"),
      /^modelRoles:\n  default: provider\/model:free\n$/u,
    );
    assert.deepEqual(
      await writeOmpModelRolesConfig(configPath, [
        { role: "default", value: "provider/model:free" },
      ]),
      { success: true },
    );
    assert.equal((await readdir(join(dir, "profiles", "work", "agent"))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无效 YAML 时不写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-config-"));
  const configPath = join(dir, "config.yml");
  try {
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

test("旧核角色从手动档位切换 auto，再 unset 删除字段且保留其他 YAML 与备份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-clear-"));
  const configPath = join(dir, "config.yml");
  const original = [
    "# account config",
    "modelRoles:",
    "  # role guidance",
    "  default: provider/model:high # retain guidance",
    "  task: [provider/one, provider/two] # untouched role",
    "otherSetting: true # untouched",
    "",
  ].join("\n");
  try {
    await writeFile(configPath, original);
    const automatic = await writeOmpModelRolesConfig(configPath, [
      { role: "default", value: "auto" },
    ]);
    assert.equal(automatic.success, true);
    if (!automatic.success) return;
    assert.equal(await readFile(automatic.backupPath!, "utf8"), original);
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: true,
      roles: [
        { role: "default", value: "auto" },
        { role: "task", value: "provider/one,provider/two" },
      ],
    });
    const beforeClear = await readFile(configPath, "utf8");
    const cleared = await writeOmpModelRolesConfig(configPath, [{ role: "default", value: "" }]);
    assert.equal(cleared.success, true);
    if (!cleared.success) return;
    assert.equal(await readFile(cleared.backupPath!, "utf8"), beforeClear);
    assert.equal(
      await readFile(configPath, "utf8"),
      original.replace(
        "  default: provider/model:high # retain guidance\n",
        "  # retain guidance\n",
      ),
    );
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: true,
      roles: [{ role: "task", value: "provider/one,provider/two" }],
    });
    assert.deepEqual(await writeOmpModelRolesConfig(configPath, [{ role: "default", value: "" }]), {
      success: true,
    });
    const files = await readdir(dir);
    assert.equal(files.filter((name) => name.includes(".bak-")).length, 2);
    assert.equal(
      files.some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("首次 unset 不创建配置，同批首次保存只写模型与 auto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-first-unset-"));
  const configPath = join(dir, "config.yml");
  try {
    assert.deepEqual(await writeOmpModelRolesConfig(configPath, [{ role: "default", value: "" }]), {
      success: true,
    });
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual(
      await writeOmpModelRolesConfig(configPath, [
        { role: "default", value: "" },
        { role: "task", value: "provider/model" },
        { role: "smol", value: "auto" },
      ]),
      { success: true },
    );
    assert.deepEqual(await readOmpModelRolesConfig(configPath), {
      success: true,
      roles: [
        { role: "task", value: "provider/model" },
        { role: "smol", value: "auto" },
      ],
    });
    assert.deepEqual(await readdir(dir), ["config.yml"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("删除最后角色或 flow mapping 角色后仍可重读，保留无关角色和注释", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-role-map-clear-"));
  const configPath = join(dir, "config.yml");
  try {
    for (const original of [
      "modelRoles:\n  default: auto # last role note\nother: true # other note\n",
      "modelRoles: { default: auto }\nother: true # other note\n",
      "modelRoles: { default: auto, task: provider/model }\nother: true # other note\n",
    ]) {
      await writeFile(configPath, original);
      const result = await writeOmpModelRolesConfig(configPath, [{ role: "default", value: "" }]);
      assert.equal(result.success, true);
      const remaining = original.includes("task:")
        ? [{ role: "task", value: "provider/model" }]
        : [];
      assert.deepEqual(await readOmpModelRolesConfig(configPath), {
        success: true,
        roles: remaining,
      });
      const raw = await readFile(configPath, "utf8");
      assert.match(raw, /other: true # other note/u);
      if (original.includes("last role note")) assert.match(raw, /# last role note/u);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
