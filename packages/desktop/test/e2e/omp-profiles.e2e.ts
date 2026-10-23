import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { DEFAULT_WORKSPACE, getE2EAppDataPaths } from "./helpers/desktop-app.js";
import { startDraftFromProject, waitForProjectRow } from "./helpers/project-sidebar.js";
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
import { runOmpNativeSource } from "./helpers/omp-native-acceptance.js";
import { setPluginPresentation } from "./helpers/plugin-management-lifecycle.js";

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
async function selectRole(role: string, model: string) {
  const control = tid(`omp-role-select-${role}`);
  await control.waitForDisplayed({ timeout: 30000 });
  expect(await control.isEnabled()).toBe(true);
  await control.scrollIntoView();
  // JSON value 中的双引号会破坏 WDIO selectByAttribute 生成的 XPath；按真实 option 的索引选择。
  const value = JSON.stringify({ provider: OMP_PROVIDER_ID, modelId: model });
  const values = await control.$$("option").map((option) => option.getAttribute("value"));
  const index = values.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  await control.selectByIndex(index);
  expect(await control.getValue()).toBe(value);
}
async function saveRole(role: string, model: string) {
  await selectRole(role, model);
  await saveSelectedRole(role);
}
async function saveSelectedRole(role: string) {
  expect(await tid(`omp-role-save-${role}`).isEnabled()).toBe(true);
  await click(`omp-role-save-${role}`);
  await browser.waitUntil(
    async () => {
      // notice 仅在保存成功后渲染；等待时读取真实错误，不能让缺失 notice 掩盖 CAS/原生失败。
      const result = await browser.execute(() => ({
        notice: document
          .querySelector('[data-testid="omp-config-notice"]')
          ?.getAttribute("data-message-id"),
        error: document.querySelector('[data-testid="omp-config-error"]')?.textContent,
      }));
      if (result.error) throw new Error(`Native CAS role save failed: ${result.error}`);
      return result.notice === "omp.configuration.roleSaved";
    },
    { timeout: 30000, timeoutMsg: "Native CAS role save did not complete" },
  );
}
async function nativeRoles(roleIds: string[]) {
  return runOmpNativeSource<
    Record<string, { userValue: string | null; effectiveValue: string | null; source: string }>
  >(
    `import { resolve } from "node:path";
     import { pathToFileURL } from "node:url";
     // The parent selects the actual OMP checkout at runtime, not a bundled test implementation.
     const { Settings } = await import(pathToFileURL(resolve(process.env.OMP_E2E_SOURCE_DIR, "config/settings.ts")).href);
     const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR });
     const roles = Object.fromEntries(${JSON.stringify(roleIds)}.map(id => [id, {
       userValue: settings.getGlobalModelRole(id) ?? null,
       effectiveValue: settings.getModelRole(id) ?? null,
       source: settings.getModelRoleSource(id),
     }]));
     console.log("OMP_E2E_RESULT:" + JSON.stringify(roles));`,
    DEFAULT_WORKSPACE,
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
async function sidebarView(view: "projects" | "grouped") {
  // 分组入口只在分组视图挂载；默认项目视图不能直接查找新建分组按钮。
  // 使用真实视图菜单切换，随后恢复项目视图，保留项目新建草稿与任务选择的原有路径。
  await click("sidebar-view-menu");
  await click(`sidebar-view-${view}`);
  if (view === "grouped") {
    await tid("task-group-add").waitForDisplayed({ timeout: 30000 });
    // 按钮可用才表示实际运行域的组织读取完成，避免把加载中的空列表当成 B 域隔离成功。
    await tid("task-group-add").waitForClickable({ timeout: 30000 });
  } else {
    await waitForProjectRow(DEFAULT_WORKSPACE);
  }
}
async function expectNoTasks(ids: string[]) {
  for (const id of ids) expect(await tid(`task-item-${id}`).isExisting()).toBe(false);
}
async function pendingRolesReadOnly() {
  await tid("omp-role-profile-pending").waitForDisplayed({ timeout: 30000 });
  // 一次读取全部真实控件，保留缺失与fieldset继承差异；失败输出必须标出具体id。
  const ids = [
    "omp-role-select-smol",
    "omp-role-save-smol",
    "omp-custom-role-id",
    "omp-custom-role-add",
  ];
  // pending 提示由 profile guard 先发布；角色目录在后续原生读取完成后才渲染，不能把提示当成目录 ready。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (testIds) =>
          testIds.every((id) => document.querySelector(`[data-testid="${id}"]`) !== null),
        ids,
      ),
    { timeout: 30000, timeoutMsg: "Native pending-profile role controls did not load" },
  );
  const controls = await browser.execute(
    (testIds) =>
      testIds.map((id) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        const fieldsets: Array<{ testId: string | null; disabled: boolean }> = [];
        for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLFieldSetElement) {
            fieldsets.push({
              testId: parent.getAttribute("data-testid"),
              disabled: parent.disabled,
            });
          }
        }
        return {
          id,
          exists: Boolean(element),
          disabled: element?.matches(":disabled") ?? false,
          ownDisabled: element?.hasAttribute("disabled") ?? false,
          fieldsets,
        };
      }),
    ids,
  );
  await writeFile(
    resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `omp-pending-role-controls-${Date.now()}.json`),
    JSON.stringify(controls, null, 2),
  );
  expect(controls.map(({ id, exists, disabled }) => ({ id, exists, disabled }))).toEqual(
    ids.map((id) => ({ id, exists: true, disabled: true })),
  );
}

async function captureProfilePresentation(rootTestId: string, label: string) {
  const targetUrl = await browser.getUrl();
  const originalSize = await browser.electron.execute((electron, url) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.webContents.getURL() === url,
    );
    if (!target) throw new Error("Profile presentation requires the current Electron window");
    const [width, height] = target.getContentSize();
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error(
        `Invalid current Electron content size: ${JSON.stringify({ width, height })}`,
      );
    }
    return { width, height };
  }, targetUrl);
  const originalTheme = await browser.execute(() =>
    document.documentElement.classList.contains("theme-zai-light") ? "zai-light" : "zai-dark",
  );
  const savedSettings: { locale?: unknown } = JSON.parse(
    await readFile(resolve(getE2EAppDataPaths().appDataDir, "setting.json"), "utf8"),
  );
  const locale = savedSettings.locale === "en-US" ? "en-US" : "zh-CN";
  try {
    for (const viewport of [
      { width: 1440, height: 1000, name: "wide" },
      { width: 900, height: 720, name: "narrow" },
    ]) {
      await setPluginPresentation({ locale, theme: "zai-light", ...viewport });
      await tid(rootTestId).waitForDisplayed({ timeout: 30000 });
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              document.documentElement.classList.contains("theme-zai-light") &&
              document
                .getAnimations()
                .every(
                  (animation) =>
                    animation.playState !== "running" ||
                    animation.effect?.getTiming().iterations === Infinity,
                ),
          ),
        {
          timeout: 30000,
          timeoutMsg: "Profile presentation did not reach its light-theme stable layout",
        },
      );
      const layout = await browser.execute((testId) => {
        const root = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (!root) throw new Error(`Missing profile presentation surface: ${testId}`);
        const surfaces = [
          root,
          ...Array.from(root.querySelectorAll<HTMLElement>("main, div")).filter(
            (element) => getComputedStyle(element).overflowY === "auto",
          ),
        ];
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          surfaces: surfaces.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              left: rect.left,
              right: rect.right,
            };
          }),
        };
      }, rootTestId);
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
      for (const surface of layout.surfaces) {
        expect(surface.clientWidth).toBeGreaterThan(0);
        expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 1);
        expect(surface.left).toBeGreaterThanOrEqual(-1);
        expect(surface.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
      }
      await browser.saveScreenshot(
        resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${label}-zai-light-${viewport.name}.png`),
      );
    }
  } finally {
    await setPluginPresentation({ locale, theme: originalTheme, ...originalSize });
  }
}

describe("OMP workspace profiles / native role and temporary model GUI", () => {
  // WDIO 在进入 body 前固定单个 it 的 120 秒外层期限，body 内 this.timeout 无法覆盖。
  // 按原生 Profile 生命周期串行验收；共享真实磁盘与会话，不重置 fixture，也不放宽期限。
  let root: string;
  let originalProfile: string;
  let secondAgent: string;
  let sentinelPath: string;
  let originalConfigPath: string;
  let sentinel: string;
  let product: { name: string; windows: string[] };
  let a: string;
  let existing: string;
  let other: string;
  let b: string;
  let groupId: string | null;
  let savedA: string;
  let beforeB: string;

  it("configures profiles without a session, blocks pending role writes, and saves native roles", async () => {
    // 与原用例一致，在 runner 完成隔离 fixture 初始化后读取环境。
    root = process.env.OMP_CONFIG_ROOT ?? "";
    const originalAgent = process.env.PI_CODING_AGENT_DIR;
    originalProfile = process.env.OMP_PROFILE || "default";
    secondAgent = resolve(root, "profiles", "profile-b", "agent");
    sentinelPath = process.env.OMP_E2E_UPSTREAM_SENTINEL ?? "";
    if (!root || !originalAgent) throw new Error("Isolated native profile directories required");
    originalConfigPath = resolve(originalAgent, "config.yml");
    if (
      !sentinelPath ||
      !sentinelPath.startsWith(resolve(getE2EAppDataPaths().homeDir, ".zcode"))
    ) {
      throw new Error("Runner-owned upstream sentinel required");
    }
    sentinel = await readFile(sentinelPath, "utf8");
    expect(sentinel).toBe('{"upstream":"must-remain-untouched"}\n');
    await prepareV4ConversationE2E({ skipProvider: true });
    product = await browser.electron.execute((electron) => ({
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
    // 原因：只读目录输入先以空值挂载，再由异步设置读取填充；可见不代表数据域已就绪。
    await browser.waitUntil(async () => (await dataRoot.getValue()) !== "", {
      timeout: 30000,
      timeoutMsg: "Readonly data directory did not finish loading",
    });
    expect(await dataRoot.getValue()).toBe(`${root}_ompcode`);
    expect(await dataRoot.getAttribute("readonly")).not.toBeNull();
    expect(await tid("settings-data-base-dir-browse").isExisting()).toBe(false);
    expect(await tid("settings-data-base-dir-save").isExisting()).toBe(false);
    await click("settings-section-nav-modelProvider");
    await tid("omp-workspace-profiles").waitForDisplayed({ timeout: 30000 });
    // 容器和默认 option 在目录读取前已渲染；active/selected 仅在原生 profiles 结果落入同一 state 后才发布。
    await profileState(originalProfile);
    const profileOptions = await tid("omp-profile-select")
      .$$("option")
      .map((option) => option.getAttribute("value"));
    expect(profileOptions).toContain("");
    expect(profileOptions).toContain("profile-b");
    await captureProfilePresentation("settings-page", "omp-profile-settings");
    // Profile 属于模型供应商设置；Team 设置仅编辑成员，角色与临时模型使用当前会话配置入口。
    // Workspace selection exists before any chat; next-start must not switch the runtime.
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    // 已保存下次启动选择仍可撤销；pending 只约束旧域角色持久写，不锁选择器。
    expect(await tid("omp-profile-select").isEnabled()).toBe(true);
    expect(await tid("omp-profile-save-next").isEnabled()).toBe(true);
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState(originalProfile);
    await click("settings-back-button");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    a = (await run("OMP_E2E_PROFILE_A_BASE")).sessionId!;
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    existing = (await run("OMP_E2E_PROFILE_EXISTING_BASE")).sessionId!;
    await selectV4TaskById(a);
    await settings("modelProvider");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    await click("settings-back-button");
    await selectV4TaskById(a);
    await click("omp-config-open");
    await pendingRolesReadOnly();
    await click("omp-config-cancel");
    await settings("modelProvider");
    await profileState(originalProfile, "profile-b");
    expect(await tid("omp-profile-select").isEnabled()).toBe(true);
    expect(await tid("omp-profile-save-next").isEnabled()).toBe(true);
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
    await settings("modelProvider");
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState(originalProfile);
    await click("settings-back-button");
    await selectV4TaskById(a);
    await click("omp-config-open");
    await saveRole("smol", "omp-alternate");
    await tid("omp-custom-role-id").setValue("e2e-reviewer");
    await click("omp-custom-role-add");
    await saveRole("e2e-reviewer", "omp-alternate");
    savedA = await readFile(originalConfigPath, "utf8");
    const roleReadback = await nativeRoles(["smol", "e2e-reviewer"]);
    for (const id of ["smol", "e2e-reviewer"]) {
      expect(roleReadback[id]).toEqual({
        userValue: `${OMP_PROVIDER_ID}/omp-alternate`,
        effectiveValue: `${OMP_PROVIDER_ID}/omp-alternate`,
        source: "global",
      });
    }
    expect(parseDocument(savedA).getIn(["modelRoles", "smol"])).toBe(
      `${OMP_PROVIDER_ID}/omp-alternate`,
    );
    await click("omp-config-cancel");
  });

  it("rejects an external native role revision and only saves after explicit readback and rebase", async () => {
    await click("omp-config-open");
    await selectRole("smol", OMP_MODEL_ID);
    // 先建立真实 GUI 脏草稿，再模拟同 profile TUI/编辑器写入；热刷新不得偷偷更新其 CAS 基线。
    const externalRole = `${OMP_PROVIDER_ID}/external-model-unavailable`;
    const external = parseDocument(await readFile(originalConfigPath, "utf8"));
    expect(external.errors).toHaveLength(0);
    external.setIn(["modelRoles", "smol"], externalRole);
    const externalSource = external.toString();
    await writeFile(originalConfigPath, externalSource);
    await click("omp-role-save-smol");
    await browser.waitUntil(
      async () => (await tid("omp-config-error").getText()).includes("revision_conflict"),
      {
        timeout: 30000,
        timeoutMsg: "Concurrent native role edit did not report revision_conflict",
      },
    );
    expect(await readFile(originalConfigPath, "utf8")).toBe(externalSource);
    expect((await nativeRoles(["smol"])).smol).toEqual({
      userValue: externalRole,
      effectiveValue: externalRole,
      source: "global",
    });
    await tid("omp-config-external-change").waitForDisplayed({ timeout: 30000 });
    // 显式读取保留用户草稿；只有用户采用最新 revision 后才能重试，不关闭重开或自动重放。
    await click("omp-config-refresh");
    await tid("omp-config-rebase").waitForEnabled({ timeout: 30000 });
    expect(await tid("omp-role-select-smol").getValue()).toBe(
      JSON.stringify({ provider: OMP_PROVIDER_ID, modelId: OMP_MODEL_ID }),
    );
    expect(await readFile(originalConfigPath, "utf8")).toBe(externalSource);
    await click("omp-config-rebase");
    await selectRole("smol", "omp-alternate");
    await saveSelectedRole("smol");
    savedA = await readFile(originalConfigPath, "utf8");
    const persisted = parseDocument(savedA);
    expect(persisted.getIn(["modelRoles", "smol"])).toBe(`${OMP_PROVIDER_ID}/omp-alternate`);
    expect(persisted.getIn(["modelRoles", "e2e-reviewer"])).toBe(
      `${OMP_PROVIDER_ID}/omp-alternate`,
    );
    expect((await nativeRoles(["smol"])).smol).toEqual({
      userValue: `${OMP_PROVIDER_ID}/omp-alternate`,
      effectiveValue: `${OMP_PROVIDER_ID}/omp-alternate`,
      source: "global",
    });
    await click("omp-config-cancel");
  });

  it("reads native roles after restart and isolates temporary models to the selected session", async () => {
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
    await captureProfilePresentation("omp-configuration-panel", "omp-profile-roles-restored");
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
    other = (await run("OMP_E2E_PROFILE_A_NEW")).sessionId!;
    expect(other).not.toBe(a);
    await assertRequestModel("OMP_E2E_PROFILE_A_NEW", OMP_MODEL_ID);
    await selectV4TaskById(a);
    await run("OMP_E2E_PROFILE_A_TEMP_AGAIN");
    await assertRequestModel("OMP_E2E_PROFILE_A_TEMP_AGAIN", "omp-alternate");
    beforeB = await readFile(resolve(secondAgent, "config.yml"), "utf8");
    await selectV4TaskById(other);
    await run("OMP_E2E_PROFILE_A_RECENT_BASE");
    await assertRequestModel("OMP_E2E_PROFILE_A_RECENT_BASE", OMP_MODEL_ID);
    await sidebarView("grouped");
    await click("task-group-add");
    const groupTitle = tid("task-group-title-input");
    await groupTitle.waitForDisplayed({ timeout: 30000 });
    await groupTitle.setValue("OMP_PROFILE_A_GROUP");
    await groupTitle.click();
    await browser.keys("Enter");
    const group = $('[data-task-group-title="OMP_PROFILE_A_GROUP"]');
    await group.waitForDisplayed({ timeout: 30000 });
    groupId = await group.getAttribute("data-task-group-id");
    expect(groupId).toBeTruthy();
    await browser.keys("Escape");
    await sidebarView("projects");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectModel(OMP_MODEL_ID);
    await switchV4Model(OMP_PROVIDER_ID, "omp-alternate", "disabled");
    await setV4ComposerText("OMP_PROFILE_A_UNSENT");
    await settings("modelProvider");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await profileState(originalProfile, "profile-b");
    await click("settings-back-button");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText(
      "OMP_PROFILE_A_UNSENT",
      "Saving pending profile changed the active draft",
    );
    await expectModel("omp-alternate");
    expect(await readFile(originalConfigPath, "utf8")).toBe(savedA);
    expect(await readFile(resolve(secondAgent, "config.yml"), "utf8")).toBe(beforeB);
  });

  it("isolates profile B tasks, groups, draft, Recent and persisted role configuration", async () => {
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await settings("modelProvider");
    await profileState("profile-b");
    await click("settings-back-button");
    await sidebarView("grouped");
    expect(await $(`[data-task-group-id="${groupId}"]`).isExisting()).toBe(false);
    await sidebarView("projects");
    await expectNoTasks([a, existing, other]);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-profile-b-active.png"),
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText("", "Profile B leaked profile A draft");
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    b = (await run("OMP_E2E_PROFILE_B_BASE")).sessionId!;
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
    // v2：新任务取原生 default role，不能继承刚发送会话的临时模型。
    await expectModel(OMP_MODEL_ID);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await setV4ComposerText("OMP_PROFILE_B_UNSENT");
    await settings("modelProvider");
    await tid("omp-profile-select").selectByAttribute(
      "value",
      originalProfile === "default" ? "" : originalProfile,
    );
    await click("omp-profile-save-next");
    await profileState("profile-b", originalProfile);
    await click("settings-back-button");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerText(
      "OMP_PROFILE_B_UNSENT",
      "Pending A selection changed actual B draft",
    );
    await expectModel(OMP_MODEL_ID);
  });

  it("restores each profile's own native roles, draft and Recent across profile restarts", async () => {
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await settings("modelProvider");
    await profileState(originalProfile);
    await click("settings-back-button");
    await expectNoTasks([b]);
    await sidebarView("grouped");
    await $(
      `[data-task-group-id="${groupId}"][data-task-group-title="OMP_PROFILE_A_GROUP"]`,
    ).waitForDisplayed({ timeout: 30000 });
    await sidebarView("projects");
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
    // 清空正文后丢弃临时草稿配置，再从真实新建入口观察原生 default role。
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
    await settings("modelProvider");
    await tid("omp-profile-select").selectByAttribute("value", "profile-b");
    await click("omp-profile-save-next");
    await click("settings-back-button");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await expectNoTasks([a, existing, other]);
    await sidebarView("grouped");
    expect(await $(`[data-task-group-id="${groupId}"]`).isExisting()).toBe(false);
    await sidebarView("projects");
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
    // v2：清空已保存草稿后恢复原生 default，而不是上次会话的临时模型。
    await expectModel(OMP_MODEL_ID);
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
