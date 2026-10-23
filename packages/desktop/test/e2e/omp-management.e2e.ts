import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
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
import {
  readNativeOmpModels,
  readNativeOmpThinking,
  readNativeOmpAuthFingerprint,
  writeNativeOmpApiKey,
  type NativeOmpModel,
} from "./helpers/omp-native-acceptance.js";

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
  authMatchesExpected: boolean;
  authPresent: boolean;
}
async function probes(): Promise<ProbeRecord[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Local OMP fixture required");
  const response = await fetch(`${url}/__management_requests`);
  if (!response.ok) throw new Error(`Management ledger: ${response.status}`);
  return response.json() as Promise<ProbeRecord[]>;
}
const modelRow = (provider: string, model: string) =>
  $(
    `[data-testid="omp-native-model-row"][data-omp-model-provider="${provider}"][data-omp-model-id="${model}"]`,
  );
async function probeModel(model: string, state: "success" | "failure", provider = OMP_PROVIDER_ID) {
  const before = (await probes()).length;
  const row = modelRow(provider, model);
  await row.waitForDisplayed({ timeout: 30000 });
  const button = row.$('[data-testid="omp-native-model-test"]');
  await button.scrollIntoView({ block: "center" });
  await button.waitForClickable({ timeout: 15000 });
  await button.click();
  const feedback = row.$('[data-testid="omp-native-model-test-result"]');
  await feedback.waitForDisplayed({ timeout: 30000 });
  await browser.waitUntil(
    async () => {
      const message = await feedback.getText();
      return state === "success"
        ? /connected|连接成功/iu.test(message)
        : message.includes("OMP_E2E_MANAGEMENT_AUTH_FAILURE");
    },
    { timeout: 30000, timeoutMsg: `Native connection probe did not report ${state}` },
  );
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
    if (provider === "omp-auth-storage") expect(record.authMatchesExpected).toBe(true);
  }
}

async function openModels() {
  if (!(await tid(testId(TID_SETTINGS_SECTION_NAV, "modelProvider")).isDisplayed())) {
    await prepareV4ConversationE2E({ skipProvider: true });
    await click(TID_TASK_SETTINGS_BUTTON);
  }
  await click(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  await tid("omp-native-model-management").waitForDisplayed({ timeout: 30000 });
}

async function visibleCatalog(): Promise<
  Array<Pick<NativeOmpModel, "provider" | "id" | "name" | "thinking">>
> {
  const rows = await $$('[data-testid="omp-native-model-row"]');
  const result: Array<Pick<NativeOmpModel, "provider" | "id" | "name" | "thinking">> = [];
  for (const row of rows) {
    const provider = await row.getAttribute("data-omp-model-provider");
    const id = await row.getAttribute("data-omp-model-id");
    const name = await row.getAttribute("data-omp-model-name");
    const thinkingAttribute = await row.getAttribute("data-omp-model-thinking-levels");
    if (!provider || !id || !name || thinkingAttribute === null) {
      throw new Error(
        "Native model row is missing provider, model identity, name or thinking levels",
      );
    }
    const thinking = JSON.parse(thinkingAttribute) as string[];
    expect(await row.getText()).toContain(name);
    for (const effort of thinking) expect(await row.getText()).toContain(effort);
    const heading = tid(`omp-native-provider-${provider}`);
    expect(await heading.$("[data-omp-provider-name]").getText()).toBe(provider);
    result.push({ provider, id, name, thinking });
  }
  return result.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

async function expectNativeCatalog(label: string) {
  const cliModels = await readNativeOmpModels(DEFAULT_WORKSPACE);
  // 公开CLI列出efforts，但不输出TUI auto选项所需的unverified标志；用同原生registry补证。
  const capabilities = await readNativeOmpThinking(DEFAULT_WORKSPACE);
  const native = cliModels
    .map((model) => {
      const capability = capabilities.find(
        (entry) => entry.provider === model.provider && entry.id === model.id,
      );
      expect(capability).toBeDefined();
      expect(capability!.efforts).toEqual(model.thinking ?? []);
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        thinking: model.reasoning
          ? ["disabled", ...(!capability!.unverified ? ["auto"] : []), ...capability!.efforts]
          : ["disabled"],
      };
    })
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  expect(native.length).toBeGreaterThan(0);
  await browser.waitUntil(
    async () => JSON.stringify(await visibleCatalog()) === JSON.stringify(native),
    {
      timeout: 30000,
      timeoutMsg:
        "GUI native provider/model/name/thinking catalog differs from public omp models ls --json",
    },
  );
  await writeFile(
    artifact(`omp-management-catalog-${label}.json`),
    JSON.stringify(
      {
        command: "models ls --json",
        cwd: DEFAULT_WORKSPACE,
        profile: process.env.OMP_PROFILE,
        offline: process.env.OMP_OFFLINE,
        cliModels,
        nativeThinkingCapabilities: capabilities,
        native,
        gui: await visibleCatalog(),
      },
      null,
      2,
    ),
  );
}

async function appendNativeProvider(provider: string, model: string, auth: "none" | "oauth") {
  const path = resolve(process.env.PI_CODING_AGENT_DIR!, "models.yml");
  const document = parseDocument(await readFile(path, "utf8"));
  if (document.errors.length) throw new Error("Invalid isolated native models.yml");
  document.setIn(["providers", provider], {
    baseUrl: `${process.env.OMP_E2E_PROVIDER_URL}/v1`,
    auth,
    api: "openai-completions",
    models: [{ id: model, name: `Native ${model}`, reasoning: true }],
  });
  await writeFile(path, document.toString());
}

async function selectNativeModel(provider: string, model: string) {
  await click(TID_SETTINGS_BACK_BUTTON);
  await click(TID_CHAT_MODEL_SELECT_TRIGGER);
  const providerTrigger = tid("composer-provider-trigger");
  await providerTrigger.waitForDisplayed({ timeout: 15000 });
  await providerTrigger.moveTo();
  await providerTrigger.click();
  await click(testId(TID_CHAT_MODEL_SELECT_GROUP, `omp-provider:${provider}`));
  const value = encodeCustomModelValue(provider, model);
  const item = tid(testId(TID_CHAT_MODEL_SELECT_ITEM, value));
  await item.waitForClickable({ timeout: 15000 });
  expect(await item.getAttribute("data-model-option-locked")).not.toBe("true");
  await item.click();
  await browser.keys("Escape");
  await browser.waitUntil(
    async () =>
      (await tid(TID_CHAT_MODEL_SELECT_TRIGGER).getAttribute("data-model-current-value")) === value,
    { timeout: 30000, timeoutMsg: `Native keyless model was not selectable: ${provider}/${model}` },
  );
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
    // 完整刷新恢复工作区而非临时设置页；通过真实入口重新打开后核对原生保存结果。
    await click(TID_TASK_SETTINGS_BUTTON);
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
    await openModels();
    await browser.saveScreenshot(artifact("omp-management-model-page-open.png"));
    await probeModel(OMP_MODEL_ID, "success");
    await browser.saveScreenshot(artifact("omp-management-provider-success.png"));
    await probeModel("omp-alternate", "failure");
    await browser.saveScreenshot(artifact("omp-management-provider-auth-error.png"));
  });

  it("OMP-M03: public native CLI and GUI expose the same provider, model names and thinking levels without provider login", async function () {
    this.timeout(120000);
    await openModels();
    await expectNativeCatalog("initial");
    const page = tid("omp-native-model-management");
    expect(await page.$$("input")).toHaveLength(0);
    expect(await page.$$('input[type="password"],form')).toHaveLength(0);
    const controls = await page.$$("button,a");
    for (const control of controls) {
      expect(await control.getText()).not.toMatch(
        /(?:log\s?in|sign\s?in|log\s?out|oauth|api\s?key|登录|登出|密钥)/iu,
      );
    }
    const native = await readNativeOmpModels(DEFAULT_WORKSPACE);
    // company和codeagent是原生互斥启动lane；分隔离run比较，不伪造为同一目录。
    const builtins = native.filter(
      (model) => ![OMP_PROVIDER_ID, "omp-anthropic"].includes(model.provider),
    );
    const lane = process.env.OMP_E2E_MANAGEMENT_LANE || "company";
    expect(builtins.some((model) => model.provider === lane)).toBe(true);
    expect(
      builtins.some((model) => model.provider === (lane === "company" ? "codeagent" : "company")),
    ).toBe(false);
    await writeFile(
      artifact("omp-management-builtin-coverage.json"),
      JSON.stringify(
        {
          platform: process.platform,
          lane,
          builtinEntries: builtins,
          builtinConnectivityRequested: false,
          providerOAuthLoginVerified: false,
        },
        null,
        2,
      ),
    );
    await browser.saveScreenshot(artifact("omp-management-native-directory.png"));
    const builtin = builtins.find((model) => model.provider === lane)!;
    await selectNativeModel(builtin.provider, builtin.id);
    await browser.saveScreenshot(artifact("omp-management-builtin-selected.png"));
  });

  it("OMP-M04: external native models and auth writes hot-update the open GUI and connection probes use stored credentials", async function () {
    this.timeout(150000);
    await openModels();
    // 实际外部文件写入后不点Refresh、不重连、不重载Renderer。
    await appendNativeProvider("omp-hot-keyless", "omp-hot-chat", "none");
    await modelRow("omp-hot-keyless", "omp-hot-chat").waitForDisplayed({ timeout: 30000 });
    await expectNativeCatalog("external-models");
    await probeModel("omp-hot-chat", "success", "omp-hot-keyless");
    await appendNativeProvider("omp-auth-storage", "omp-auth-chat", "oauth");
    // 声明需认证但没有key的模型必须由原生getAvailable排除，而非GUI伪造ready。
    expect(
      (await readNativeOmpModels(DEFAULT_WORKSPACE)).some(
        (model) => model.provider === "omp-auth-storage",
      ),
    ).toBe(false);
    expect(await modelRow("omp-auth-storage", "omp-auth-chat").isExisting()).toBe(false);
    const configPath = resolve(process.env.PI_CODING_AGENT_DIR!, "config.yml");
    const modelsPath = resolve(process.env.PI_CODING_AGENT_DIR!, "models.yml");
    const configBefore = await readFile(configPath, "utf8");
    const modelsBefore = await readFile(modelsPath, "utf8");
    // 仅本地原生storage登录凭据写入模拟；不是外部Provider OAuth登录验收。
    await writeNativeOmpApiKey("omp-auth-storage", DEFAULT_WORKSPACE);
    await modelRow("omp-auth-storage", "omp-auth-chat").waitForDisplayed({ timeout: 30000 });
    await expectNativeCatalog("external-auth");
    const authBeforeProbe = await readNativeOmpAuthFingerprint(DEFAULT_WORKSPACE);
    await probeModel("omp-auth-chat", "success", "omp-auth-storage");
    const authAfterProbe = await readNativeOmpAuthFingerprint(DEFAULT_WORKSPACE);
    expect(authAfterProbe).toBe(authBeforeProbe);
    await writeFile(
      artifact("omp-management-auth-persistence.json"),
      JSON.stringify(
        {
          credentialsUnchangedByProbe: authAfterProbe === authBeforeProbe,
          configUnchanged: (await readFile(configPath, "utf8")) === configBefore,
          modelsUnchanged: (await readFile(modelsPath, "utf8")) === modelsBefore,
          nativeAuthFingerprint: authAfterProbe,
          externalProviderOAuthLoginVerified: false,
        },
        null,
        2,
      ),
    );
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(modelsPath, "utf8")).toBe(modelsBefore);
    expect(modelsBefore).not.toContain(process.env.OMP_E2E_NATIVE_AUTH_KEY!);
    await browser.saveScreenshot(artifact("omp-management-native-auth-hot-update.png"));
    await selectNativeModel("omp-hot-keyless", "omp-hot-chat");
    await browser.saveScreenshot(artifact("omp-management-external-model-selected.png"));
  });
});
