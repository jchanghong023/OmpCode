import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, getE2EAppDataPaths } from "./helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "./helpers/v4-conversation.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";

const skillName = "omp-management-e2e";
const artifact = (name: string) => resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, name);
const tid = (id: string) => $(`[data-testid="${id}"]`);
async function click(id: string) {
  const element = tid(id);
  await element.waitForDisplayed({ timeout: 30000 });
  await element.scrollIntoView({ block: "center" });
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
}
async function readOptional(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
}
async function openSkills() {
  await click(testId(TID_SETTINGS_SECTION_NAV, "skill"));
  const trigger = $('[data-plugin-scope-trigger="true"]');
  await trigger.waitForDisplayed({ timeout: 30000 });
  if ((await trigger.getAttribute("data-plugin-scope-key")) !== DEFAULT_WORKSPACE) {
    await trigger.click();
    const item = $(
      `[role="menuitemradio"][data-plugin-scope-key="${DEFAULT_WORKSPACE.replace(/\\/gu, "\\\\")}"]`,
    );
    await item.waitForClickable({ timeout: 15000 });
    await item.click();
  }
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-plugin-scope-key")) === DEFAULT_WORKSPACE,
    { timeout: 15000, timeoutMsg: "Skill settings did not select the isolated workspace" },
  );
}
const skillSwitch = () =>
  $(
    `//span[text()="${skillName}"]/ancestor::div[contains(@class,"grid-cols-")][1]//*[@role="switch"]`,
  );
async function waitSkillState(enabled: boolean) {
  await browser.waitUntil(
    async () => {
      const control = skillSwitch();
      return (
        (await control.isExisting()) &&
        (await control.getAttribute("aria-checked")) === String(enabled)
      );
    },
    { timeout: 30000, timeoutMsg: `Native skill did not become enabled=${enabled}` },
  );
}
async function disabledExtensions(): Promise<string[]> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Isolated OMP profile required");
  const document = parseDocument(await readFile(resolve(agentDir, "config.yml"), "utf8"));
  if (document.errors.length) throw new Error("Invalid native profile configuration");
  const config = document.toJS() as { disabledExtensions?: unknown };
  const value = config.disabledExtensions;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid native disabledExtensions");
  }
  return value as string[];
}
interface ProbeRecord {
  path: string;
  body: ModelRequest & { stream?: boolean };
  status: number;
}
async function probes(): Promise<ProbeRecord[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Local OMP fixture required");
  const response = await fetch(`${url}/__management_requests`);
  if (!response.ok) throw new Error(`Management ledger: ${response.status}`);
  return response.json() as Promise<ProbeRecord[]>;
}
async function probeModel(model: string, state: "success" | "failure") {
  const before = (await probes()).length;
  const row = $(`[data-model-provider-model-id="${model}"]`);
  await row.waitForDisplayed({ timeout: 30000 });
  const button = row.$("button:has(svg.lucide-unplug)");
  await button.scrollIntoView({ block: "center" });
  await button.waitForClickable({ timeout: 15000 });
  await button.click();
  const feedback = $(`[data-provider-detail-feedback-state="${state}"]`);
  await feedback.waitForDisplayed({ timeout: 30000 });
  const text = await feedback.getText();
  if (state === "success") expect(text).toMatch(/connected|连接成功/iu);
  else expect(text).toContain("OMP_E2E_MANAGEMENT_AUTH_FAILURE");
  await browser.waitUntil(async () => (await probes()).length > before, {
    timeout: 15000,
    timeoutMsg: "GUI connection check did not reach the native provider",
  });
  const records = (await probes()).slice(before);
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record.path).toBe("/v1/chat/completions");
    expect(record.body.model).toBe(model);
    expect(record.body.stream).toBe(true);
    expect(record.body.messages).toEqual([{ role: "user", content: "Reply OK." }]);
    expect(record.status).toBe(state === "success" ? 200 : 401);
  }
}

describe("OMP native management / real Settings GUI and isolated profile", () => {
  before(async () => {
    // 合法资源是测试输入，不伪造 Skill 列表、开关或运行状态。
    const dir = resolve(DEFAULT_WORKSPACE, ".agents", "skills", skillName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, "SKILL.md"),
      [
        "---",
        `name: ${skillName}`,
        "description: Isolated native management acceptance skill.",
        "---",
        "",
        "Use only for isolated native management acceptance. No tools are required.",
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await writeFile(
      artifact("omp-management-provider-requests.json"),
      JSON.stringify(await probes(), null, 2),
    );
  });

  it("OMP-M01: GUI skill toggles persist only in the current native profile and survive refresh", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await click(TID_TASK_SETTINGS_BUTTON);
    await openSkills();
    const notice = $('[data-skill-toggle-scope="profile"]');
    await notice.waitForDisplayed({ timeout: 30000 });
    expect(await notice.getText()).toMatch(/profile/iu);
    await waitSkillState(true);
    const paths = getE2EAppDataPaths();
    const legacyPaths = [
      resolve(DEFAULT_WORKSPACE, ".zcode", "config.json"),
      resolve(paths.storageRoot, "config.json"),
      resolve(paths.storageRoot, "cli", "config.json"),
    ];
    const legacyBefore = await Promise.all(legacyPaths.map(readOptional));
    await skillSwitch().click();
    await waitSkillState(false);
    await browser.waitUntil(
      async () => (await disabledExtensions()).includes(`skill:${skillName}`),
      { timeout: 15000, timeoutMsg: "Skill disable did not persist to native profile config.yml" },
    );
    await browser.saveScreenshot(artifact("omp-management-skill-disabled.png"));
    const refresh = $('button[aria-label="Refresh"],button[aria-label="刷新"]');
    await refresh.waitForClickable({ timeout: 15000 });
    await refresh.click();
    await waitSkillState(false);
    await browser.refresh();
    await openSkills();
    await waitSkillState(false);
    await $('[data-skill-toggle-scope="profile"]').waitForDisplayed({ timeout: 30000 });
    expect(await disabledExtensions()).toContain(`skill:${skillName}`);
    await browser.saveScreenshot(artifact("omp-management-skill-refreshed.png"));
    await skillSwitch().click();
    await waitSkillState(true);
    await browser.waitUntil(
      async () => !(await disabledExtensions()).includes(`skill:${skillName}`),
      { timeout: 15000, timeoutMsg: "Skill enable did not remove native profile disable entry" },
    );
    expect(await Promise.all(legacyPaths.map(readOptional))).toEqual(legacyBefore);
    await browser.saveScreenshot(artifact("omp-management-skill-enabled.png"));
    await writeFile(
      artifact("omp-management-skill-persistence.json"),
      JSON.stringify(
        {
          skillName,
          nativeConfig: resolve(process.env.PI_CODING_AGENT_DIR!, "config.yml"),
          disabledEntryRemoved: true,
          legacyPaths,
          legacyUnchanged: true,
        },
        null,
        2,
      ),
    );
  });

  it("OMP-M02: GUI connection checks reach native provider and expose success and authentication failure", async function () {
    this.timeout(90000);
    if (!(await tid(testId(TID_SETTINGS_SECTION_NAV, "modelProvider")).isDisplayed())) {
      await prepareV4ConversationE2E({ skipProvider: true });
      await click(TID_TASK_SETTINGS_BUTTON);
    }
    await click(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await click(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${OMP_PROVIDER_ID}`));
    await probeModel(OMP_MODEL_ID, "success");
    await browser.saveScreenshot(artifact("omp-management-provider-success.png"));
    await probeModel("omp-alternate", "failure");
    await browser.saveScreenshot(artifact("omp-management-provider-auth-error.png"));
  });
});
