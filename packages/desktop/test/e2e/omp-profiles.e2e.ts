import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { DEFAULT_WORKSPACE, getE2EAppDataPaths } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  setV4ComposerText,
  switchV4Model,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart-runtime.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";

const tid = (id: string) => $(`[data-testid="${id}"]`);
async function click(id: string) {
  const control = tid(id);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.waitForClickable({ timeout: 30000 });
  await control.click();
}
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated local profile provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Model ledger ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function run(marker: string) {
  await sendV4Prompt(marker);
  await waitForV4TimelineContaining(`${marker}_DONE`);
  return waitForV4Pane(
    (pane) => Boolean(pane.sessionId && pane.sessionId !== "draft" && !pane.canStop),
    "Native profile turn did not settle",
    60000,
  );
}
async function assertRequestModel(marker: string, model: string) {
  const matches = (await requests()).filter(
    (request) =>
      request.tools?.length &&
      [...request.messages].reverse().find((message) => message.role === "user")?.content &&
      JSON.stringify(
        [...request.messages].reverse().find((message) => message.role === "user")?.content,
      ).includes(marker),
  );
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.every((request) => request.model === model)).toBe(true);
}
async function saveRole(role: string, model: string) {
  const control = tid(`omp-role-select-${role}`);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.selectByAttribute(
    "value",
    JSON.stringify({ provider: OMP_PROVIDER_ID, modelId: model }),
  );
  await click(`omp-role-save-${role}`);
  await browser.waitUntil(
    async () =>
      (await tid("omp-config-notice").getAttribute("data-message-id")) ===
      "omp.configuration.roleSaved",
    { timeout: 30000, timeoutMsg: "Native CAS role save did not complete" },
  );
}
async function profileState(active: string, selected = active) {
  await browser.waitUntil(
    async () =>
      (await tid("omp-profile-state").getAttribute("data-active-profile")) === active &&
      (await tid("omp-profile-state").getAttribute("data-selected-profile")) === selected,
    { timeout: 60000, timeoutMsg: `Profile did not become active=${active}, selected=${selected}` },
  );
}

async function settings(section: "general" | "modelProvider") {
  await click("task-settings-button");
  await click(`settings-section-nav-${section}`);
}
async function expectModel(model: string) {
  await browser.waitUntil(async () => (await getV4ModelConfig()).model === model, {
    timeout: 30000,
    timeoutMsg: `Composer did not restore model ${model}`,
  });
}
async function expectNoTasks(ids: string[]) {
  for (const id of ids) expect(await tid(`task-item-${id}`).isExisting()).toBe(false);
}
async function pendingRolesReadOnly() {
  await tid("omp-role-profile-pending").waitForDisplayed({ timeout: 30000 });
  // fieldset disabled 不保证子元素自身有 disabled 属性，检查浏览器有效禁用语义。
  for (const id of [
    "omp-role-select-smol",
    "omp-role-save-smol",
    "omp-custom-role-id",
    "omp-custom-role-add",
  ]) {
    expect(
      await browser.execute(
        (testId) =>
          document.querySelector(`[data-testid="${testId}"]`)?.matches(":disabled") ?? false,
        id,
      ),
    ).toBe(true);
  }
}

describe("OMP workspace profiles / native role and temporary model GUI", () => {
  it("configures without a session, isolates profiles, reads roles after restart, and changes only the selected session temporarily", async function () {
    this.timeout(300000);
    const root = process.env.OMP_CONFIG_ROOT;
    const originalAgent = process.env.PI_CODING_AGENT_DIR;
    if (!root || !originalAgent) throw new Error("Isolated native profile directories required");
    const originalProfile = process.env.OMP_PROFILE || "default";
    const secondAgent = resolve(root, "profiles", "profile-b", "agent");
    const sentinelPath = process.env.OMP_E2E_UPSTREAM_SENTINEL;
    if (
      !sentinelPath ||
      !sentinelPath.startsWith(resolve(getE2EAppDataPaths().homeDir, ".zcode"))
    ) {
      throw new Error("Runner-owned upstream sentinel required");
    }
    const sentinel = await readFile(sentinelPath, "utf8");
    expect(sentinel).toBe('{"upstream":"must-remain-untouched"}\n');
    await prepareV4ConversationE2E({ skipProvider: true });
    const product = await browser.electron.execute((electron) => ({
      name: electron.app.getName(),
      windows: electron.BrowserWindow.getAllWindows()
        .filter((window) => window.isVisible())
        .map((window) => window.getTitle()),
    }));
    expect(product.name).toBe("OmpCode");
    expect(product.windows.some((title) => title.includes("OmpCode"))).toBe(true);
    await settings("general");
    const dataRoot = tid("settings-data-base-dir-input");
    await dataRoot.waitForDisplayed({ timeout: 30000 });
    expect(await dataRoot.getValue()).toBe(`${root}_ompcode`);
    expect(await dataRoot.getAttribute("readonly")).not.toBeNull();
    expect(await tid("settings-data-base-dir-browse").isExisting()).toBe(false);
    expect(await tid("settings-data-base-dir-save").isExisting()).toBe(false);
    await click("settings-section-nav-modelProvider");
    await tid("omp-workspace-profiles").waitForDisplayed({ timeout: 30000 });
    const profileOptions = await tid("omp-profile-select")
      .$$("option")
      .map((option) => option.getAttribute("value"));
    expect(profileOptions).toContain("");
    expect(profileOptions).toContain("profile-b");
    await click("settings-back-button");
    await click("omp-team-sidebar-open");
    await tid("omp-workspace-profiles").waitForDisplayed({ timeout: 30000 });
    await profileState(originalProfile);
    // Workspace selection exists before any chat; next-start must not switch the runtime.
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState(originalProfile);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const a = (await run("OMP_E2E_PROFILE_A_BASE")).sessionId!;
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const existing = (await run("OMP_E2E_PROFILE_EXISTING_BASE")).sessionId!;
    await selectV4TaskById(a);
    await click("omp-team-sidebar-open");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    await click("omp-team-configure");
    await pendingRolesReadOnly();
    await click("omp-config-cancel");
    await settings("modelProvider");
    await profileState(originalProfile, "profile-b");
    await click("settings-back-button");
    await selectV4TaskById(a);
    await click("omp-config-open");
    await pendingRolesReadOnly();
    await click("omp-config-cancel");
    await selectV4TaskById(a);
    await waitForV4Pane(
      (pane) => pane.sessionId === a,
      "Saving pending profile changed the running task",
    );
    await click("omp-team-sidebar-open");
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState(originalProfile);
    await click("omp-team-configure");
    await saveRole("smol", "omp-alternate");
    await tid("omp-custom-role-id").setValue("e2e-reviewer");
    await click("omp-custom-role-add");
    await saveRole("e2e-reviewer", "omp-alternate");
    const originalConfigPath = resolve(originalAgent, "config.yml");
    const savedA = await readFile(originalConfigPath, "utf8");
    expect(parseDocument(savedA).getIn(["modelRoles", "smol"])).toBe(
      `${OMP_PROVIDER_ID}/omp-alternate`,
    );
    await click("omp-config-cancel");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(a);
    await click("omp-config-open");
    await browser.waitUntil(
      async () =>
        (await tid("omp-role-smol").getText()).includes(`${OMP_PROVIDER_ID}/omp-alternate`),
      { timeout: 30000, timeoutMsg: "Saved native role did not survive runtime restart" },
    );
    await tid("omp-custom-role-id").setValue("e2e-reviewer");
    await click("omp-custom-role-add");
    await browser.waitUntil(
      async () =>
        (await tid("omp-role-e2e-reviewer").getText()).includes(`${OMP_PROVIDER_ID}/omp-alternate`),
      { timeout: 30000, timeoutMsg: "Custom role was not read back after restart" },
    );
    const temporary = tid("omp-temporary-model");
    await temporary.scrollIntoView();
    await temporary.selectByVisibleText(`${OMP_PROVIDER_ID}/omp-alternate`);
    await browser.waitUntil(
      async () =>
        (await tid("omp-config-notice").getAttribute("data-message-id")) ===
        "omp.configuration.temporaryModelSwitched",
      { timeout: 30000, timeoutMsg: "Temporary model was not acknowledged by native session" },
    );
    expect(await readFile(originalConfigPath, "utf8")).toBe(savedA);
    await click("omp-config-cancel");
    await run("OMP_E2E_PROFILE_A_TEMP");
    await assertRequestModel("OMP_E2E_PROFILE_A_TEMP", "omp-alternate");
    await selectV4TaskById(existing);
    await run("OMP_E2E_PROFILE_EXISTING_UNCHANGED");
    await assertRequestModel("OMP_E2E_PROFILE_EXISTING_UNCHANGED", OMP_MODEL_ID);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const other = (await run("OMP_E2E_PROFILE_A_NEW")).sessionId!;
    expect(other).not.toBe(a);
    await assertRequestModel("OMP_E2E_PROFILE_A_NEW", OMP_MODEL_ID);
    await selectV4TaskById(a);
    await run("OMP_E2E_PROFILE_A_TEMP_AGAIN");
    await assertRequestModel("OMP_E2E_PROFILE_A_TEMP_AGAIN", "omp-alternate");
    const beforeB = await readFile(resolve(secondAgent, "config.yml"), "utf8");
    await selectV4TaskById(other);
    await run("OMP_E2E_PROFILE_A_RECENT_BASE");
    await assertRequestModel("OMP_E2E_PROFILE_A_RECENT_BASE", OMP_MODEL_ID);
    await click("task-group-add");
    const groupTitle = tid("task-group-title-input");
    await groupTitle.waitForDisplayed({ timeout: 30000 });
    await groupTitle.setValue("OMP_PROFILE_A_GROUP");
    await groupTitle.click();
    await browser.keys("Enter");
    const group = $('[data-task-group-title="OMP_PROFILE_A_GROUP"]');
    await group.waitForDisplayed({ timeout: 30000 });
    const groupId = await group.getAttribute("data-task-group-id");
    expect(groupId).toBeTruthy();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectModel(OMP_MODEL_ID);
    await switchV4Model(OMP_PROVIDER_ID, "omp-alternate", "disabled");
    await setV4ComposerText("OMP_PROFILE_A_UNSENT");
    await click("omp-team-sidebar-open");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText(
      "OMP_PROFILE_A_UNSENT",
      "Saving pending profile changed the active draft",
    );
    await expectModel("omp-alternate");
    expect(await readFile(originalConfigPath, "utf8")).toBe(savedA);
    expect(await readFile(resolve(secondAgent, "config.yml"), "utf8")).toBe(beforeB);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await click("omp-team-sidebar-open");
    await profileState("profile-b");
    expect(await $(`[data-task-group-id="${groupId}"]`).isExisting()).toBe(false);
    await expectNoTasks([a, existing, other]);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-b-active.png"),
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("", "Profile B leaked profile A draft");
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const b = (await run("OMP_E2E_PROFILE_B_BASE")).sessionId!;
    expect(b).not.toBe(a);
    expect(b).not.toBe(other);
    await assertRequestModel("OMP_E2E_PROFILE_B_BASE", OMP_MODEL_ID);
    await click("omp-config-open");
    await saveRole("slow", "omp-alternate");
    await click("omp-config-cancel");
    expect(await readFile(originalConfigPath, "utf8")).toBe(savedA);
    expect(
      parseDocument(await readFile(resolve(secondAgent, "config.yml"), "utf8")).getIn([
        "modelRoles",
        "slow",
      ]),
    ).toBe(`${OMP_PROVIDER_ID}/omp-alternate`);
    expect(parseDocument(beforeB).getIn(["modelRoles", "slow"])).toBe(
      `${OMP_PROVIDER_ID}/${OMP_MODEL_ID}`,
    );
    expect(parseDocument(savedA).getIn(["modelRoles", "slow"])).toBe(
      `${OMP_PROVIDER_ID}/${OMP_MODEL_ID}`,
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectModel(OMP_MODEL_ID);
    await switchV4Model(OMP_PROVIDER_ID, "omp-alternate", "disabled");
    await run("OMP_E2E_PROFILE_B_RECENT");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectModel("omp-alternate");
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await setV4ComposerText("OMP_PROFILE_B_UNSENT");
    await click("omp-team-sidebar-open");
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState("profile-b", originalProfile);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText(
      "OMP_PROFILE_B_UNSENT",
      "Pending A selection changed actual B draft",
    );
    await expectModel(OMP_MODEL_ID);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await click("omp-team-sidebar-open");
    await profileState(originalProfile);
    await expectNoTasks([b]);
    await $(
      `[data-task-group-id="${groupId}"][data-task-group-title="OMP_PROFILE_A_GROUP"]`,
    ).waitForDisplayed({ timeout: 30000 });
    await selectV4TaskById(a);
    await click("omp-config-open");
    await browser.waitUntil(
      async () =>
        (await tid("omp-role-smol").getText()).includes(`${OMP_PROVIDER_ID}/omp-alternate`),
      {
        timeout: 30000,
        timeoutMsg: "Returning to A did not restore its native role configuration",
      },
    );
    await click("omp-config-cancel");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("OMP_PROFILE_A_UNSENT", "Profile A draft did not recover");
    await expectModel("omp-alternate");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-a-draft-restored.png"),
    );
    // 清空正文后丢弃临时草稿配置，再从真实新建入口观察已接纳的 Recent。
    await setV4ComposerText("");
    await selectV4TaskById(other);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("", "Clearing A draft did not take effect");
    await expectModel(OMP_MODEL_ID);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-a-recent-restored.png"),
    );
    await selectV4TaskById(other);
    await run("OMP_E2E_PROFILE_A_REOPEN");
    await assertRequestModel("OMP_E2E_PROFILE_A_REOPEN", OMP_MODEL_ID);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-a-restored.png"),
    );
    // 同一 OMP root 下的两个实际运行 profile；两物理 root 的 SQLite 隔离另由后端验收。
    await click("omp-team-sidebar-open");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await expectNoTasks([a, existing, other]);
    expect(await $(`[data-task-group-id="${groupId}"]`).isExisting()).toBe(false);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("OMP_PROFILE_B_UNSENT", "Profile B draft did not recover");
    await expectModel(OMP_MODEL_ID);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-b-draft-restored.png"),
    );
    await setV4ComposerText("");
    await selectV4TaskById(b);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("", "Clearing B draft did not take effect");
    await expectModel("omp-alternate");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-b-recent-restored.png"),
    );
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-evidence.json"),
      JSON.stringify(
        {
          configRoot: root,
          appRoot: getE2EAppDataPaths().storageRoot,
          product,
          profiles: [originalProfile, "profile-b"],
          sessions: { a, existing, other, b },
          group: { id: groupId, title: "OMP_PROFILE_A_GROUP" },
          configA: parseDocument(await readFile(originalConfigPath, "utf8")).toJS(),
          configB: parseDocument(await readFile(resolve(secondAgent, "config.yml"), "utf8")).toJS(),
          sentinel: { path: sentinelPath, unchanged: true },
          requests: await requests(),
        },
        null,
        2,
      ),
    );
  });
});
