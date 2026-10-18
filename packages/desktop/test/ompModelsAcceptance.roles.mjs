import assert from "node:assert/strict";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";

export const PRIMARY = "zcode-mock/scripted";
export const ALTERNATE = "zcode-mock/scripted-alt";
export const configAt = (agent) => join(agent, "config.yml");
export const readConfig = async (agent) => parse(await readFile(configAt(agent), "utf8"));
export const sectionOf = (page) =>
  page
    .getByTestId("omp-model-roles-section")
    .or(page.getByRole("dialog", { name: "模型设置", exact: true }));
export async function openRoles(page, entry = "settings") {
  if (entry === "settings") {
    await page.getByRole("button", { name: "设置", exact: true }).last().click();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
  } else {
    await page.getByTestId("chat-model-select-trigger").click();
    await page.getByRole("menuitem", { name: "管理模型", exact: true }).click();
  }
  await sectionOf(page).waitFor({ state: "visible" });
}
export async function closeRoles(page) {
  // 设置入口是完整页面，不响应弹窗的 Escape；Composer 入口才是可关闭的 Dialog。
  if (await page.getByRole("dialog", { name: "模型设置", exact: true }).isVisible()) {
    await page.keyboard.press("Escape");
  } else {
    await page.getByTestId("settings-back-button").click();
  }
  await sectionOf(page).waitFor({ state: "hidden" });
}
const rowOf = (page, role) => sectionOf(page).getByTestId(`omp-role-${role}`);
const roleModel = (page, role) =>
  sectionOf(page).getByRole("combobox", { name: role, exact: true });
const roleEffort = (page, role) =>
  sectionOf(page).getByRole("combobox", { name: `${role} 思考等级`, exact: true });
async function choose(page, trigger, name) {
  await trigger.click();
  await page.getByRole("option", { name, exact: true }).click();
}
export async function assertRole(page, role, modelName, effort = "high") {
  const selected = await roleModel(page, role).innerText();
  assert.equal(selected.trim(), modelName);
  assert.equal((await roleEffort(page, role).innerText()).trim(), effort);
}
async function saved(page, role) {
  await rowOf(page, role)
    .getByText(/^已保存(?:$| ·)/u)
    .waitFor({ state: "visible" });
}
async function waitConfig(agent, role, selection) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const config = await readConfig(agent);
    if (config.modelRoles[role] === selection) return config;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    (await readConfig(agent)).modelRoles[role],
    selection,
    `${role} must be durably saved`,
  );
}
function assertOnlyRoleChanged(before, after, role) {
  const without = (config) => {
    const copy = structuredClone(config);
    delete copy.modelRoles[role];
    return copy;
  };
  assert.deepEqual(
    without(after),
    without(before),
    "Saving one role must not replace other roles or configuration",
  );
}
async function saveRole(page, agent, role, selector, name, effort = "high") {
  const before = await readConfig(agent);
  const expected = `${selector}:${effort}`;
  const trigger = roleModel(page, role);
  if ((await trigger.innerText()).trim() !== name) {
    await choose(page, trigger, name);
    await saved(page, role);
  }
  const label = effort;
  if (
    (await roleEffort(page, role).innerText()).trim() !== label ||
    (await readConfig(agent)).modelRoles[role] !== expected
  ) {
    await choose(page, roleEffort(page, role), label);
    await saved(page, role);
  }
  const after = await waitConfig(agent, role, expected);
  assertOnlyRoleChanged(before, after, role);
  await assertRole(page, role, name, label);
  return after;
}
export async function exerciseRoleSaves(page, manifest) {
  const agent = manifest.defaultAgent;
  await openRoles(page);
  await saveRole(page, agent, "default", PRIMARY, "ZCode Mock");
  await saveRole(page, agent, "task", ALTERNATE, "ZCode Mock Alt");
  await closeRoles(page);
  await openRoles(page);
  await assertRole(page, "default", "ZCode Mock");
  await assertRole(page, "task", "ZCode Mock Alt");
  await closeRoles(page);
  await openRoles(page, "toolbar");
  // 同一 role 连续成功保存 + 跨 role 保存证明读取的是各自最新修订，而非目录全局修订。
  await saveRole(page, agent, "default", ALTERNATE, "ZCode Mock Alt");
  await saveRole(page, agent, "task", PRIMARY, "ZCode Mock");
  await saveRole(page, agent, "default", PRIMARY, "ZCode Mock");
  await saveRole(page, agent, "task", ALTERNATE, "ZCode Mock Alt");
  await closeRoles(page);
  await openRoles(page, "toolbar");
  await assertRole(page, "default", "ZCode Mock");
  await assertRole(page, "task", "ZCode Mock Alt");

  const file = configAt(agent);
  const original = await readFile(file, "utf8");
  const backup = `${file}.models-acceptance-blocked`;
  let saveFailure;
  await rename(file, backup);
  await mkdir(file);
  try {
    await choose(page, roleModel(page, "default"), "ZCode Mock Alt");
    const failure = rowOf(page, "default").getByText(/^保存失败: /u);
    await failure.waitFor({ state: "visible" });
    saveFailure = await failure.innerText();
    assert.match(saveFailure, /保存失败|无法保存|写入失败|EISDIR|permission denied/iu);
    await assertRole(page, "default", "ZCode Mock Alt");
    assert.equal(
      await readFile(backup, "utf8"),
      original,
      "Failed save must leave original recoverable",
    );
  } finally {
    await rmdir(file);
    await rename(backup, file);
  }
  // RPC 角色行没有独立重试按钮；用真实档位入口重新提交同一模型，再恢复 High。
  await choose(page, roleEffort(page, "default"), "默认档位");
  await saved(page, "default");
  await waitConfig(agent, "default", ALTERNATE);
  await assertRole(page, "default", "ZCode Mock Alt", "默认档位");
  await choose(page, roleEffort(page, "default"), "high");
  await saved(page, "default");
  await waitConfig(agent, "default", `${ALTERNATE}:high`);
  await saveRole(page, agent, "default", PRIMARY, "ZCode Mock");

  const beforeConflict = await readFile(file, "utf8");
  const beforeDocument = parse(beforeConflict);
  assert.equal(beforeDocument.modelRoles.default, `${PRIMARY}:high`);
  // 合法 YAML 可以使用单引号键或 flow mapping；按文档节点修订，不限定产品的排版。
  const document = parseDocument(beforeConflict);
  assert.deepEqual(
    document.errors,
    [],
    "External revision requires a valid persisted YAML document",
  );
  assert.equal(document.getIn(["modelRoles", "default"]), `${PRIMARY}:high`);
  document.setIn(["modelRoles", "default"], `${ALTERNATE}:high`);
  const external = document.toString();
  await writeFile(file, external);
  assertOnlyRoleChanged(beforeDocument, parse(external), "default");
  // 真实外部修改制造 stale revision；冲突不得由 GUI 静默直写绕过核心。
  await choose(page, roleEffort(page, "default"), "max");
  const conflict = rowOf(page, "default").getByText(/^保存失败: /u);
  await conflict.waitFor({ state: "visible" });
  const revisionConflict = await conflict.innerText();
  await assertRole(page, "default", "ZCode Mock", "max");
  assert.equal(
    await readFile(file, "utf8"),
    external,
    "Conflict must preserve actual external revision",
  );
  await closeRoles(page);
  await openRoles(page);
  await assertRole(page, "default", "ZCode Mock Alt");
  await saveRole(page, agent, "default", PRIMARY, "ZCode Mock");
  // 最终默认角色也必须由真实 GUI 保存；与最后临时会话的 Primary/High 明确区分。
  await saveRole(page, agent, "default", ALTERNATE, "ZCode Mock Alt");
  await assertRole(page, "task", "ZCode Mock Alt");
  assert.ok(
    (await readFile(file, "utf8")).includes(`# models-acceptance-preserve-${manifest.marker}`),
    "Unrelated comments must survive all role writes",
  );
  await closeRoles(page);
  return {
    saveFailure,
    revisionConflict,
    originalConfiguration: original,
    externalConfiguration: external,
  };
}
export async function saveProfilePending(page, manifest, profile) {
  const before = await Promise.all(
    [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
      readFile(configAt(agent), "utf8"),
    ),
  );
  await openRoles(page);
  await choose(
    page,
    page.getByRole("combobox", { name: "OMP Profile", exact: true }),
    profile || "默认 profile",
  );
  const restartNotice = "Profile 已保存。请重启应用后使用该 profile 的配置、模型和会话。";
  await page.getByText(restartNotice, { exact: true }).waitFor({ state: "visible" });
  for (const entry of ["settings", "toolbar"]) {
    if (entry === "toolbar") {
      await closeRoles(page);
      await openRoles(page, entry);
    }
    await page.getByText(restartNotice, { exact: true }).waitFor({ state: "visible" });
    for (const role of ["default", "task"]) {
      assert.equal(
        await roleModel(page, role).count(),
        0,
        `${entry} must expose no writable old-profile role while restart is pending`,
      );
      assert.equal(await roleEffort(page, role).count(), 0);
    }
  }
  assert.deepEqual(
    await Promise.all(
      [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
        readFile(configAt(agent), "utf8"),
      ),
    ),
    before,
  );
  await closeRoles(page);
}
