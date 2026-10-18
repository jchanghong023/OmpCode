import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import { reveal, readMockRequests } from "./ompMockInteractions.assertions.mjs";
import {
  assertInteractionTools,
  completeInteraction,
  exerciseAsk,
  exerciseExtension,
  submitInteraction,
} from "./ompInteractionsAcceptance.assertions.mjs";
import {
  assertLiveModelEvidence,
  readInteractionRecords,
} from "./ompInteractionsAcceptance.records.mjs";
import { LIVE_CASES, PROBES, markerFor } from "./ompInteractionsAcceptance.contract.mjs";
import { assertSensitiveDraftsAbsent } from "./ompInteractionsAcceptance.storage.mjs";

const manifestPath = process.env.OMP_E2E_RUNTIME_MANIFEST;
const endpoint = process.env.OMP_E2E_CDP_URL;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const phase = process.env.OMP_E2E_PHASE;
assert.ok(
  manifestPath && endpoint && evidenceDir,
  "Use the owned real-OMP launcher and evidence directory",
);
assert.ok(phase === "live" || phase === "recovery");
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(runtime.suite, "interactions");
assert.equal(runtime.acceptance.suite, "interactions");
assert.deepEqual(runtime.acceptance.liveCases, LIVE_CASES);
const nonce = runtime.acceptance.nonce;
const receiptPath = join(evidenceDir, "interactions-live.json");
const browser = await chromium.connectOverCDP(endpoint);
try {
  const prefix = `${runtime.rendererUrl.replace(/\/+$/u, "")}/`;
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => candidate.url().startsWith(prefix));
  assert.equal(pages.length, 1, "Exactly one owned renderer must match the launcher manifest");
  const page = pages[0];
  page.setDefaultTimeout(30_000);
  const rendererProblems = [];
  page.on("console", (message) => {
    // 取消/核心超时允许业务诊断；只把未处理运行时或 React 生命周期错误当作渲染失败。
    const runtimeProblem =
      /(?:uncaught|unhandled(?:rejection| promise)|minified react error|invalid hook call|rendered (?:more|fewer) hooks|cannot update a component|each child in a list|changing[\s\S]*(?:controlled|uncontrolled)|react[\s\S]*(?:warning|error)|hydration failed)/iu;
    if (["warning", "error"].includes(message.type()) && runtimeProblem.test(message.text()))
      rendererProblems.push(message.text());
  });
  page.on("pageerror", (error) => rendererProblems.push(error.message));
  const assertIsolation = async () => {
    const evidence = await readIsolationEvidence(runtime.isolationEvidence);
    assert.equal(evidence.electronPid, runtime.electronPid);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.mode, "hidden-native-windows");
    assert.ok(evidence.windows.length > 0);
    for (const window of evidence.windows) {
      assert.equal(window.visible, false);
      assert.equal(window.focused, false);
      assert.equal(window.focusable, false);
    }
  };
  await assertIsolation();
  const initial = await readMockRequests(runtime);
  assert.equal(
    initial.calls.length,
    0,
    "Opening/recovering a GUI must never auto-send a model request",
  );
  const rows = page.locator('li[data-testid^="task-item-"]');
  const taskIds = () =>
    rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  let saved;
  let taskTestId;
  let before;
  if (phase === "live") {
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
    before = await taskIds();
    await exerciseAsk(page, runtime, "ask-rich");
    await page.waitForFunction((previous) => {
      const created = [...document.querySelectorAll('li[data-testid^="task-item-"]')]
        .map((node) => node.getAttribute("data-testid"))
        .filter((id) => !previous.includes(id));
      return created.length === 1 && /^task-item-[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(created[0]);
    }, before);
    const created = (await taskIds()).filter((id) => !before.includes(id));
    assert.equal(created.length, 1);
    taskTestId = created[0];
    await exerciseAsk(page, runtime, "ask-cancel");
    const deadline = await exerciseAsk(page, runtime, "ask-timeout");
    for (const name of PROBES) await exerciseExtension(page, runtime, name);
    await assertInteractionTools(page, nonce);
    const records = await readInteractionRecords(runtime, taskTestId);
    await assertLiveModelEvidence(runtime, records, deadline);
    assert.deepEqual(
      (await taskIds()).filter((id) => !before.includes(id)),
      [taskTestId],
    );
    // 普通草稿正对照由真实 Composer 编辑并在切换边界 flush；不注入 storage。
    const composer = page.getByTestId("v4-composer-input");
    await composer.fill(runtime.acceptance.publicDraft);
    await page.getByTestId(taskTestId).click();
    await composer.blur();
    let storage;
    // 用真实 CDP 可读持久事实等待 flush，不以固定 sleep 或仅空集合断言代替。
    // flush 截止与 ask deadline 独立，避免重复声明及覆盖 receipt 中的真实核心超时证据。
    const flushDeadline = Date.now() + 15_000;
    while (true) {
      storage = await assertSensitiveDraftsAbsent(page, runtime);
      if (storage.publicDraftPresent) break;
      assert.ok(
        Date.now() < flushDeadline,
        "Ordinary Composer draft must become durable through its real flush boundary",
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    storage = await assertSensitiveDraftsAbsent(page, runtime, { requirePublicDraft: true });
    saved = {
      nonce,
      runRoot: runtime.runRoot,
      launcherPid: runtime.launcherPid,
      electronPid: runtime.electronPid,
      before,
      taskTestId,
      deadline,
      records: {
        path: records.path,
        uuid: records.uuid,
        messageHash: records.messageHash,
        results: records.results,
        askEvidence: records.askEvidence,
      },
      storage,
    };
    await writeFile(receiptPath, JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(saved.nonce, nonce);
    assert.equal(saved.runRoot, runtime.runRoot);
    assert.notEqual(
      saved.launcherPid,
      runtime.launcherPid,
      "Recovery must use a new launcher process",
    );
    assert.notEqual(
      saved.electronPid,
      runtime.electronPid,
      "Recovery must use a new Electron process",
    );
    before = saved.before;
    taskTestId = saved.taskTestId;
    await page.getByTestId(taskTestId).waitFor({ state: "visible" });
    assert.deepEqual(
      (await taskIds()).filter((id) => !before.includes(id)),
      [taskTestId],
    );
    await page.getByTestId(taskTestId).click();
    await assertInteractionTools(page, nonce);
    for (const name of LIVE_CASES) {
      const marker = page.getByText(markerFor(name, nonce), { exact: true });
      if (name === "ask-cancel") {
        assert.equal(
          await marker.count(),
          0,
          "Cold restoration cannot invent an assistant completion for the natively aborted ask",
        );
        continue;
      }
      await reveal(page, marker);
      assert.equal(
        await marker.count(),
        1,
        "Cold restoration must not duplicate completed UI requests",
      );
    }
    const records = await readInteractionRecords(runtime, taskTestId, saved.records.askEvidence);
    assert.deepEqual(
      {
        path: records.path,
        uuid: records.uuid,
        messageHash: records.messageHash,
        results: records.results,
        askEvidence: records.askEvidence,
      },
      saved.records,
      "Viewing the cold real tool records cannot mutate or append parent history",
    );
    assert.equal(
      (await readMockRequests(runtime)).calls.length,
      0,
      "History, tool expansion and draft restoration are read-only",
    );
    const composer = page.getByTestId("v4-composer-input");
    const restoredDraft = await composer.evaluate((node) =>
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value
        : node.innerText,
    );
    assert.equal(restoredDraft, runtime.acceptance.publicDraft);
    await assertSensitiveDraftsAbsent(page, runtime, { requirePublicDraft: true });
    await submitInteraction(page, "resume", nonce);
    await completeInteraction(page, "resume", nonce);
    const diagnostics = await readMockRequests(runtime);
    assert.equal(
      diagnostics.calls.length,
      1,
      "Only one explicitly submitted continuation may call the model",
    );
    assert.equal(diagnostics.calls[0].completed, true);
    assert.equal(diagnostics.calls[0].aborted, false);
    assert.deepEqual(diagnostics.acceptance.verified, [{ name: "resume" }]);
    const resumed = await readInteractionRecords(runtime, taskTestId, saved.records.askEvidence);
    assert.deepEqual(resumed.results, saved.records.results);
    assert.equal(
      resumed.messages.length,
      records.messages.length + 2,
      "Resume appends exactly the user and assistant, never replays any interaction",
    );
    assert.equal(
      resumed.messages.filter(
        (message) =>
          message.role === "assistant" &&
          (typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")) === markerFor("resume", nonce),
      ).length,
      1,
    );
    await assertSensitiveDraftsAbsent(page, runtime);
  }
  assert.deepEqual(
    (await taskIds()).filter((id) => !before.includes(id)),
    [taskTestId],
  );
  assert.deepEqual(
    rendererProblems,
    [],
    "Rich ask and extension UI must not produce unhandled runtime or React lifecycle errors",
  );
  await assertIsolation();
  await captureIsolationScreenshot(join(evidenceDir, `interactions-${phase}.png`));
  console.log(
    `interactions ${phase}: real OMP + local mock; rich ask/cancel/deadline and real extension UI; ${taskTestId}`,
  );
} finally {
  await browser.close();
}
