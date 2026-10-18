import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import {
  ALTERNATE,
  PRIMARY,
  assertRole,
  closeRoles,
  configAt,
  exerciseRoleSaves,
  openRoles,
  readConfig,
  saveProfilePending,
  sectionOf,
} from "./ompModelsAcceptance.roles.mjs";
import {
  assertNoReplay,
  assertOrganization,
  assertReplies,
  organizeTask,
  readDiagnostics,
  sendTurn,
  storedConversation,
  taskIds,
} from "./ompModelsAcceptance.history.mjs";

const phase = process.env.OMP_E2E_PHASE;
assert.ok(
  ["live", "profile", "default"].includes(phase),
  "Models suite requires live → profile → default",
);
assert.ok(process.env.OMP_E2E_RUNTIME_MANIFEST);
assert.ok(process.env.OMP_E2E_CDP_URL);
assert.ok(process.env.OMP_E2E_EVIDENCE_DIR);
const runtime = JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8"));
assert.equal(runtime.suite, "models");
assert.equal(runtime.phase, phase);
const manifest = runtime.acceptance;
assert.ok(manifest?.marker);
assert.deepEqual(Object.keys(manifest.turns).sort(), ["default", "live", "profile"]);
assert.equal(
  manifest.turns.live.length,
  5,
  "The live acceptance cannot silently omit model/effort transitions or same-model retention",
);
assert.equal(manifest.turns.profile.length, 1);
assert.equal(manifest.turns.default.length, 1);
for (const entry of Object.values(manifest.turns).flat()) {
  assert.ok(entry.prompt && entry.reply && ["scripted", "scripted-alt"].includes(entry.model));
  assert.ok(["high", "max"].includes(entry.effort));
}
assert.equal(resolve(manifest.configRoot), resolve(runtime.configRoot));
assert.equal(resolve(manifest.workspace), resolve(runtime.requestedWorkspace));
assert.equal(resolve(manifest.defaultAgent), resolve(runtime.configRoot, "agent"));
assert.equal(
  resolve(manifest.profileAgent),
  resolve(runtime.configRoot, "profiles", "acceptance", "agent"),
);
assert.equal(runtime.profile, phase === "profile" ? "acceptance" : "");
assert.equal(runtime.mock.models.length, 2);
assert.deepEqual(runtime.mock.models.map((model) => model.id).sort(), ["scripted", "scripted-alt"]);
const evidence = process.env.OMP_E2E_EVIDENCE_DIR;
await mkdir(evidence, { recursive: true });
const receiptPath = join(evidence, `models-${manifest.marker}.json`);
const receipt = phase === "live" ? null : JSON.parse(await readFile(receiptPath, "utf8"));
if (receipt) {
  assert.equal(receipt.marker, manifest.marker);
  assert.equal(receipt.runRoot, runtime.runRoot);
  assert.notEqual(
    receipt.launcherPid,
    runtime.launcherPid,
    "Each profile transition requires a new launcher",
  );
  assert.notEqual(
    receipt.electronPid,
    runtime.electronPid,
    "Each profile transition requires a new Electron",
  );
  assert.equal(receipt.phase, phase === "profile" ? "live" : "profile");
}
async function assertIsolation() {
  const state = await readIsolationEvidence(runtime.isolationEvidence);
  assert.equal(state.electronPid, runtime.electronPid);
  assert.equal(state.verified, true);
  assert.equal(state.mode, "hidden-native-windows");
  assert.ok(state.windows.length > 0, "An empty isolation report is not evidence");
  for (const window of state.windows) {
    assert.equal(window.visible, false);
    assert.equal(window.focused, false);
    assert.equal(window.focusable, false);
  }
}
const browser = await chromium.connectOverCDP(process.env.OMP_E2E_CDP_URL);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith(runtime.rendererUrl));
  assert.ok(page, "Use only this fixture renderer");
  page.setDefaultTimeout(30_000);
  const runtimeErrors = [];
  const consoleRecords = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      consoleRecords.push({ type: message.type(), text: message.text() });
  });
  await assertIsolation();
  await assertNoReplay(runtime);

  async function assertDirectory(profile) {
    await openRoles(page);
    const names = profile ? manifest.profileModelNames : manifest.defaultModelNames;
    const absent = profile ? manifest.defaultModelNames : manifest.profileModelNames;
    const defaultCombo = sectionOf(page).getByRole("combobox", { name: "default", exact: true });
    await defaultCombo.click();
    for (const name of names)
      await page.getByRole("option", { name, exact: true }).waitFor({ state: "visible" });
    for (const name of absent)
      assert.equal(
        await page.getByRole("option", { name, exact: true }).count(),
        0,
        "Model directory must belong to the active profile, not another profile's cached catalog",
      );
    await page.keyboard.press("Escape");
    await closeRoles(page);
  }
  async function assertDefaultRoles() {
    await openRoles(page);
    await assertRole(page, "default", "ZCode Mock Alt");
    await assertRole(page, "task", "ZCode Mock Alt");
    await closeRoles(page);
  }
  let state = receipt ? { ...receipt } : { marker: manifest.marker, runRoot: runtime.runRoot };
  if (phase === "live") {
    assert.deepEqual(await taskIds(page), [], "Owned blank root must not import daily history");
    // 新任务必须在任何模型/档位手选前初始化到默认模型最高档；不能先操作再修复初值。
    // 触发器仅在目录/模型具备真实档位后出现；名称为当前中文档位，不是设置页字段名。
    const initialEffort = page.getByTestId("chat-thought-level-select-trigger");
    await initialEffort.waitFor({ state: "visible" });
    assert.equal(
      await page.getByTestId("chat-model-select-trigger").getAttribute("aria-label"),
      "zcode-mock/ZCode Mock",
    );
    assert.equal(await initialEffort.getAttribute("aria-label"), "最高");
    await assertDirectory(false);
    state.roleFailures = await exerciseRoleSaves(page, manifest);
    const beforeFiles = await Promise.all(
      [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
        readFile(configAt(agent), "utf8"),
      ),
    );
    const before = await taskIds(page);
    for (const [index, turn] of manifest.turns.live.entries())
      await sendTurn(page, runtime, turn, index);
    const created = (await taskIds(page)).filter((id) => !before.includes(id));
    assert.equal(
      created.length,
      1,
      "Temporary model changes must stay within one real conversation UUID",
    );
    state.defaultTask = created[0];
    await assertReplies(page, manifest.turns.live);
    state.organization = await organizeTask(page, state.defaultTask, manifest.marker);
    state.defaultSession = await storedConversation(
      manifest.defaultAgent,
      state.defaultTask,
      manifest.turns.live,
    );
    assert.deepEqual(
      await Promise.all(
        [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
          readFile(configAt(agent), "utf8"),
        ),
      ),
      beforeFiles,
      "First-send and continuation temporary model/effort choices must not rewrite role files",
    );
    state.defaultConfig = await readConfig(manifest.defaultAgent);
    const lastLive = manifest.turns.live.at(-1);
    assert.equal(lastLive.model, "scripted");
    assert.equal(
      lastLive.effort,
      "high",
      "Cold recovery must distinguish retained High from Primary's highest Max",
    );
    assert.notEqual(
      state.defaultConfig.modelRoles.default,
      `${PRIMARY}:${lastLive.effort}`,
      "Restoring the temporary session selection must be distinguishable from falling back to the saved role",
    );
    state.profileConfig = await readConfig(manifest.profileAgent);
    await saveProfilePending(page, manifest, "acceptance");
    assert.equal(
      await page.getByTestId(state.defaultTask).count(),
      1,
      "Saving profile must not hot-switch history",
    );
    await page.getByTestId(state.defaultTask).click();
    await assertReplies(page, manifest.turns.live);
    await assertOrganization(page, state.defaultTask, state.organization);
  } else if (phase === "profile") {
    assert.equal(
      await page.getByTestId(state.defaultTask).count(),
      0,
      "Default history must not leak to named profile",
    );
    assert.equal(
      await page.getByText(state.organization.groupName, { exact: true }).count(),
      0,
      "Default task organization must not leak",
    );
    assert.deepEqual(await taskIds(page), [], "Named profile history must start genuinely empty");
    await assertDirectory(true);
    await openRoles(page);
    await assertRole(page, "default", "ZCode Mock Alt Acceptance Profile");
    await assertRole(page, "task", "ZCode Mock Acceptance Profile");
    await closeRoles(page);
    assert.deepEqual(await readConfig(manifest.profileAgent), state.profileConfig);
    assert.deepEqual(await readConfig(manifest.defaultAgent), state.defaultConfig);
    const beforeFiles = await Promise.all(
      [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
        readFile(configAt(agent), "utf8"),
      ),
    );
    await sendTurn(page, runtime, manifest.turns.profile[0], 0);
    const ids = await taskIds(page);
    assert.equal(ids.length, 1);
    assert.notEqual(ids[0], state.defaultTask);
    state.profileTask = ids[0];
    state.profileSession = await storedConversation(
      manifest.profileAgent,
      state.profileTask,
      manifest.turns.profile,
    );
    assert.deepEqual(
      await storedConversation(manifest.defaultAgent, state.defaultTask, manifest.turns.live),
      state.defaultSession,
      "Opening the named profile must not append, reorder, or rewrite default history",
    );
    assert.deepEqual(
      await Promise.all(
        [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
          readFile(configAt(agent), "utf8"),
        ),
      ),
      beforeFiles,
    );
    await saveProfilePending(page, manifest, "");
    assert.equal(await page.getByTestId(state.defaultTask).count(), 0);
    assert.equal(
      await page.getByTestId(state.profileTask).count(),
      1,
      "Switch-back save stays pending until a new process",
    );
  } else {
    assert.equal(
      await page.getByTestId(state.profileTask).count(),
      0,
      "Named history must not leak after switching back",
    );
    assert.deepEqual(
      await taskIds(page),
      [state.defaultTask],
      "Original task identity must survive both profile restarts",
    );
    await assertDirectory(false);
    await assertDefaultRoles();
    assert.deepEqual(await readConfig(manifest.defaultAgent), state.defaultConfig);
    assert.deepEqual(await readConfig(manifest.profileAgent), state.profileConfig);
    await assertOrganization(page, state.defaultTask, state.organization);
    await page.getByTestId(state.defaultTask).click();
    await assertReplies(page, manifest.turns.live);
    await assertNoReplay(runtime);
    assert.deepEqual(
      await storedConversation(manifest.defaultAgent, state.defaultTask, manifest.turns.live),
      state.defaultSession,
    );
    assert.deepEqual(
      await storedConversation(manifest.profileAgent, state.profileTask, manifest.turns.profile),
      state.profileSession,
    );
    const beforeFiles = await Promise.all(
      [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
        readFile(configAt(agent), "utf8"),
      ),
    );
    await sendTurn(page, runtime, manifest.turns.default[0], 0);
    await assertReplies(page, [...manifest.turns.live, ...manifest.turns.default]);
    assert.deepEqual(await taskIds(page), [state.defaultTask]);
    const continued = await storedConversation(manifest.defaultAgent, state.defaultTask, [
      ...manifest.turns.live,
      ...manifest.turns.default,
    ]);
    assert.deepEqual(
      continued.records.slice(0, state.defaultSession.records.length),
      state.defaultSession.records,
      "Cold continuation must preserve every original message record as an unchanged prefix",
    );
    const appended = continued.records.slice(state.defaultSession.records.length);
    assert.equal(
      appended.length,
      2,
      "One explicit cold submission appends only one user and one assistant message",
    );
    assert.deepEqual(
      appended.map((record) => record.message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      await storedConversation(manifest.profileAgent, state.profileTask, manifest.turns.profile),
      state.profileSession,
      "Default continuation must leave named-profile history unchanged",
    );
    assert.deepEqual(
      await Promise.all(
        [manifest.defaultAgent, manifest.profileAgent].map((agent) =>
          readFile(configAt(agent), "utf8"),
        ),
      ),
      beforeFiles,
    );
    await assertOrganization(page, state.defaultTask, state.organization);
  }
  const diagnostics = await readDiagnostics(runtime);
  assert.equal(diagnostics.calls.length, manifest.turns[phase].length);
  assert.equal(diagnostics.acceptance.completed, manifest.turns[phase].length);
  assert.equal(diagnostics.acceptance.expected, manifest.turns[phase].length);
  assert.equal(diagnostics.acceptance.phase, phase);
  assert.equal((await readConfig(manifest.defaultAgent)).modelRoles.default, `${ALTERNATE}:high`);
  assert.equal((await readConfig(manifest.defaultAgent)).modelRoles.task, `${ALTERNATE}:high`);
  await captureIsolationScreenshot(
    join(evidence, `models-${phase}-${manifest.marker}.png`),
    runtime.screenshotUrl,
  );
  await assertIsolation();
  // 保存失败/修订冲突必须留下业务诊断，不能把符合负例要求的 warn/error 当作运行时崩溃。
  await writeFile(
    join(evidence, `models-console-${phase}-${manifest.marker}.json`),
    JSON.stringify(consoleRecords, null, 2),
  );
  assert.deepEqual(
    runtimeErrors,
    [],
    "Model/profile interactions must not produce unhandled renderer exceptions",
  );
  const reactOrUnhandled =
    /Invalid hook call|Rendered (?:more|fewer) hooks|React has detected a change|Maximum update depth exceeded|Cannot update a component|Each child in a list should have a unique|Encountered two children with the same key|Uncaught (?:Error|TypeError|ReferenceError|SyntaxError)|Unhandled(?:PromiseRejection| promise rejection)|An error occurred in the <[^>]+> component/u;
  assert.deepEqual(
    consoleRecords.filter((record) => reactOrUnhandled.test(record.text)),
    [],
    "Expected save-failure diagnostics do not excuse React or unhandled-runtime errors",
  );
  assert.doesNotMatch(
    await readFile(join(runtime.runRoot, "electron-stderr.log"), "utf8"),
    /omp_core_frame_decode_failed/u,
  );
  state = { ...state, phase, launcherPid: runtime.launcherPid, electronPid: runtime.electronPid };
  await writeFile(receiptPath, JSON.stringify(state, null, 2));
  await writeFile(
    join(evidence, `models-http-${phase}-${manifest.marker}.json`),
    JSON.stringify(diagnostics, null, 2),
  );
} finally {
  await browser.close();
}
