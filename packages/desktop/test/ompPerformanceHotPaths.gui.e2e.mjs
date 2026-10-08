// 公开桌面 GUI → 新内嵌适配器 → 真实 GLM；只创建本脚本标记的测试会话。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const manifestPath = process.env.OMP_E2E_RUNTIME_MANIFEST;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const marker = process.env.OMP_E2E_RUN_ID;
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(manifestPath && evidenceDir && marker);
assert.ok(["live", "stable", "cold"].includes(phase));
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(runtime.runRoot && runtime.endpoint && runtime.electronPid);
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.connectOverCDP(runtime.endpoint);
const page = browser
  .contexts()[0]
  ?.pages()
  .find((candidate) => candidate.url().startsWith(runtime.rendererUrl));
assert.ok(page, "Connect only to the isolated renderer from the manifest");
page.setDefaultTimeout(30_000);
const input = page.getByTestId("v4-composer-input").first();
const timeline = page.getByTestId("v4-timeline").first();
const evidence = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const screenshot = (name) =>
  page.screenshot({ path: join(evidenceDir, `${phase}-${name}.png`), animations: "disabled" });
const draftA = `${marker}_DRAFT_A_${"保存全文".repeat(60)}`;
const draftB = `${marker}_DRAFT_B_${"另一会话".repeat(40)}`;
const promptA = `${marker}_A：执行只读GUI验收，不使用工具、不修改文件、不改设置。请仅回复 ${marker}_A_READY。输入完整性标记：${"字符".repeat(30)}`;
const promptB = `${marker}_B：执行只读GUI验收，不使用工具、不修改文件、不改设置。请仅回复 ${marker}_B_READY。`;
const expectedCodeLines = Array.from(
  { length: 80 },
  (_, index) => `const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
);
async function readCompleteCodeLines() {
  return page
    .locator("diffs-container")
    .evaluateAll(
      (nodes) =>
        nodes
          .map((node) =>
            [...(node.shadowRoot?.querySelectorAll("[data-line][data-line-index]") ?? [])].map(
              (line) => line.textContent.replace(/\r?\n$/u, ""),
            ),
          )
          .find((lines) => lines[0] === "const line001 = 1;") ?? [],
    );
}
async function selectGlm() {
  const model = page.getByTestId("chat-model-select-trigger").first();
  if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
    await model.click();
    await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
    await page.getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash").click();
  }
  const thought = page.getByTestId("chat-thought-level-select-trigger").first();
  await thought.click();
  await page.getByTestId("chat-thought-level-select-item-low").click();
}
async function send(prompt) {
  await input.fill(prompt);
  await page.getByTestId("v4-composer-send").first().click();
}
async function switchTask(suffix) {
  await page
    .locator('li[data-testid^="task-item-"]')
    .filter({ hasText: `${marker}_${suffix}` })
    .first()
    .click();
  await input.waitFor({ state: "visible" });
  await page.waitForFunction(
    (ready) => document.querySelector('[data-testid="v4-timeline"]')?.textContent.includes(ready),
    `${marker}_${suffix}_READY`,
  );
}
async function observeStorage() {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.hotPathTelemetry = {
      writes: 0,
      blur: 0,
      streamMutations: 0,
      codeContainers: new Set(),
      sessionIds: new Set(),
      restore: () => {
        Storage.prototype.setItem = original;
      },
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zcode-v4-composer-drafts:v1:")) window.hotPathTelemetry.writes++;
      return Reflect.apply(original, this, [key, value]);
    };
    window.addEventListener("blur", () => window.hotPathTelemetry.blur++);
    const observeSessionIds = () =>
      document
        .querySelectorAll("[data-session-id]")
        .forEach((node) =>
          window.hotPathTelemetry.sessionIds.add(node.getAttribute("data-session-id")),
        );
    observeSessionIds();
    window.sessionIdObserver = new MutationObserver(observeSessionIds);
    window.sessionIdObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-session-id"],
    });
  });
}
async function persistedTexts() {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("zcode-v4-composer-drafts:v1:"))
      .flatMap((key) =>
        Object.values(JSON.parse(localStorage.getItem(key)).scopes).map((draft) => draft.text),
      ),
  );
}
async function expectDraft(expected) {
  await page.waitForFunction(
    (text) =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === text,
    expected,
  );
  assert.equal(await input.innerText(), expected);
}
try {
  await input.waitFor({ state: "visible" });
  await observeStorage();
  if (phase !== "cold") {
    if (phase === "live") {
      await page.getByRole("button", { name: "新建任务", exact: true }).last().click();
      await selectGlm();
      const prefix = promptA.slice(0, -60);
      await input.fill(prefix);
      const before = await page.evaluate(() => window.hotPathTelemetry.writes);
      await input.pressSequentially(promptA.slice(-60), { delay: 1 });
      const burstWrites = (await page.evaluate(() => window.hotPathTelemetry.writes)) - before;
      assert.ok(burstWrites <= 3, `60 typed chars rewrote all drafts ${burstWrites} times`);
      assert.equal(await input.innerText(), promptA);
      await page.getByTestId("v4-composer-send").first().click();
      await page
        .getByText(`${marker}_A_READY`, { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 120_000 });
      assert.ok(
        (await timeline.innerText()).includes(promptA),
        "Submitted user text must equal the latest editor text",
      );
      evidence.push({
        event: "high-frequency-input-send",
        characters: 60,
        burstWrites,
        submittedFullText: true,
        model: await page
          .getByTestId("chat-model-select-trigger")
          .first()
          .getAttribute("aria-label"),
      });
      await input.fill(draftA);
      // 切换任务是产品公开边界，必须保存旧 scope 的最新正文及 EditorState。
      await page.getByRole("button", { name: "新建任务", exact: true }).last().click();
      await selectGlm();
      await send(promptB);
      await page
        .getByText(`${marker}_B_READY`, { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 120_000 });
      await input.fill(draftB);
    } else {
      // 保留 live 的初次临时ID→落盘ID断裂失败；另测已打开的稳定持久scope。
      await switchTask("A");
      await input.fill(draftA);
      await switchTask("B");
      await input.fill(draftB);
      evidence.push({
        event: "stable-persisted-scopes",
        initialIdPromotion: "separate-live-failure",
      });
    }
    await switchTask("A");
    await expectDraft(draftA);
    if (phase === "live") {
      const currentSessionId = await input.evaluate((element) =>
        element.closest("[data-session-id]").getAttribute("data-session-id"),
      );
      assert.match(
        currentSessionId,
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu,
        "The first new session must switch to its persisted canonical identity",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      const saved = await page.evaluate(
        (text) =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("zcode-v4-composer-drafts:v1:"))
            .flatMap((key) =>
              Object.entries(JSON.parse(localStorage.getItem(key)).scopes)
                .filter(([, draft]) => draft.text === text)
                .map(([scope]) => scope),
            ),
        draftA,
      );
      assert.deepEqual(
        saved,
        [currentSessionId],
        "The migrated draft must have one canonical persisted scope",
      );
      const observedIds = await page.evaluate(() => [...window.hotPathTelemetry.sessionIds]);
      evidence.push({
        event: "first-session-identity-migration-and-draft",
        canonicalSessionId: currentSessionId,
        observedIds,
        oneCanonicalDraft: true,
        sidebarRestoredFullDraft: true,
      });
    }
    await page.waitForTimeout(450);
    assert.equal(await input.innerText(), draftA, "A delayed B callback must not replace A");
    await switchTask("B");
    await expectDraft(draftB);
    const changedDraftB = `${draftB}_BLUR`;
    const blurBefore = await page.evaluate(() => window.hotPathTelemetry.blur);
    await input.fill(changedDraftB);
    // 使用产品窗口按钮，仅操作 manifest 对应窗口；真实最小化产生失焦。
    await page.getByTestId("window-control-minimize").click();
    await page.waitForTimeout(60);
    const nativeWindowBlur = (await page.evaluate(() => window.hotPathTelemetry.blur)) > blurBefore;
    if (!nativeWindowBlur) {
      // CDP发送按键不会确保Windows前台焦点；背景窗口最小化没有新blur。
      // 此时只验证真实产品的生命周期监听器，证据不宣称操作系统焦点已验收。
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    }
    assert.ok((await persistedTexts()).includes(changedDraftB));
    await page.getByTestId("window-control-maximize").dispatchEvent("click");
    evidence.push({
      event: "scope-and-window-blur-flush",
      twoDistinctDrafts: true,
      nativeWindowBlur,
      lifecycleListener: true,
    });
    await switchTask("A");
    const codePrompt = `${marker}_STREAM：只读GUI验收，不使用工具。先给出句子 ${marker}_STREAM_BEGIN，然后原样输出下面的typescript代码块，保持全部80行和顺序，不修改空格、分号和变量名。最后给出句子 ${marker}_STREAM_DONE。\n\n\`\`\`typescript\n${expectedCodeLines.join("\n")}\n\`\`\``;
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="v4-timeline"]');
      window.streamObserver = new MutationObserver(() => {
        window.hotPathTelemetry.streamMutations++;
        for (const container of node.querySelectorAll("diffs-container"))
          window.hotPathTelemetry.codeContainers.add(container);
      });
      window.streamObserver.observe(node, { childList: true, subtree: true, characterData: true });
    });
    await send(codePrompt);
    await page.getByTestId("v4-stop").first().waitFor({ state: "visible", timeout: 90_000 });
    await input.fill(`${draftA}_DURING_STREAM`);
    await page
      .getByText(`${marker}_STREAM_DONE`, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 180_000 });
    await page.getByTestId("v4-composer-send").first().waitFor({ state: "visible" });
    const actualCodeLines = await readCompleteCodeLines();
    assert.deepEqual(
      actualCodeLines,
      expectedCodeLines,
      "Every rendered code line and its order must equal the complete expected result",
    );
    assert.equal(
      await input.innerText(),
      `${draftA}_DURING_STREAM`,
      "Real streaming frames must not replace the editor draft",
    );
    const stream = await page.evaluate(() => ({
      mutations: window.hotPathTelemetry.streamMutations,
      containers: window.hotPathTelemetry.codeContainers.size,
    }));
    assert.ok(stream.mutations > 2, "Observe live incremental rendering before completion");
    evidence.push({
      event: "real-stream-completion",
      ...stream,
      allCodeLines: actualCodeLines,
      exactCodeLineCount: actualCodeLines.length,
      exactFullCodeAndOrder: true,
      draftUnaffected: true,
    });
    await screenshot("stream-complete");
    await switchTask("B");
    await expectDraft(changedDraftB);
    await switchTask("A");
    await expectDraft(`${draftA}_DURING_STREAM`);
  } else {
    await switchTask("A");
    await expectDraft(`${draftA}_DURING_STREAM`);
    await page
      .getByText(`${marker}_STREAM_DONE`, { exact: true })
      .first()
      .waitFor({ state: "visible" });
    const coldCodeLines = await readCompleteCodeLines();
    assert.deepEqual(
      coldCodeLines,
      expectedCodeLines,
      "Cold recovery must render all 80 exact lines in order",
    );
    const live = JSON.parse(await readFile(join(evidenceDir, "live-hotpaths-result.json"), "utf8"));
    assert.deepEqual(
      coldCodeLines,
      live.evidence.find((event) => event.event === "real-stream-completion").allCodeLines,
      "Cold code must equal the actual live full code",
    );
    await switchTask("B");
    await expectDraft(`${draftB}_BLUR`);
    await page
      .getByText(`${marker}_B_READY`, { exact: true })
      .first()
      .waitFor({ state: "visible" });
    evidence.push({
      event: "cold-recovery",
      twoDraftsAndCompletedConversation: true,
      allCodeLines: coldCodeLines,
      exactFullCodeAndOrder: true,
    });
  }
  assert.deepEqual(errors, [], "No renderer exception during public GUI workflow");
  await screenshot("draft-restored");
  await writeFile(
    join(evidenceDir, `${phase}-hotpaths-result.json`),
    JSON.stringify(
      { kind: "real-desktop-E2E", phase, runRoot: runtime.runRoot, evidence },
      null,
      2,
    ),
  );
  console.log(`PASS ${phase} real desktop E2E: ${evidenceDir}`);
} catch (error) {
  await screenshot("failure").catch(() => {});
  await writeFile(
    join(evidenceDir, `${phase}-hotpaths-failure.json`),
    JSON.stringify({ message: error.message, errors, evidence }, null, 2),
  );
  throw error;
} finally {
  await page
    .evaluate(() => {
      window.hotPathTelemetry?.restore();
      window.streamObserver?.disconnect();
      window.sessionIdObserver?.disconnect();
    })
    .catch(() => {});
  await browser.close();
}
