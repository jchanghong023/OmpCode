import assert from "node:assert/strict";
import { join } from "node:path";
import { runComposerAssertions } from "./ompPerformanceHotPaths.composerAssertions.mjs";
import { runDraftHookAssertions } from "./ompPerformanceHotPaths.draftHookAssertions.mjs";

// 真实组件的DOM与输入断言；transport/clipboard仅在明确记录的端口边界受控。
export async function runComponentAssertions(page, evidenceDir, evidence, options = {}) {
  const summary = page.locator('[data-reasoning-streaming-text="true"]');
  await summary.filter({ hasText: "尾行" }).waitFor();
  await page.evaluate(() => {
    window.summaryIdentity = document.querySelector('[data-reasoning-streaming-text="true"]');
    window.codeIdentity = document.querySelector("diffs-container");
  });
  for (let index = 1; index <= 30; index++) {
    await page.evaluate(
      (count) =>
        window.performanceFixture.render({
          reasoning: `首行\r\n尾行${"字".repeat(count)}\r\n\r\n`,
          code: `const value = 1;\n${Array.from({ length: count }, (_, i) => `const line${i} = ${i};`).join("\n")}\n`,
        }),
      index,
    );
  }
  await page.waitForFunction(() =>
    window.performanceFixture.status().content.includes("const line29 = 29;"),
  );
  assert.equal(
    await page.evaluate(() => window.codeIdentity === document.querySelector("diffs-container")),
    true,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.summaryIdentity === document.querySelector('[data-reasoning-streaming-text="true"]'),
    ),
    true,
  );
  assert.equal(await summary.textContent(), `尾行${"字".repeat(30)}`);
  assert.equal((await page.evaluate(() => window.performanceFixture.status())).containerCount, 1);
  evidence.push({
    event: "stream-append",
    updates: 30,
    codeContainerMounts: 1,
    stableSummary: true,
  });
  await page.evaluate(() => window.performanceFixture.render({ code: "const latest = 1;\n" }));
  await page.waitForFunction(() =>
    window.performanceFixture.status().content.includes("const latest = 1;"),
  );
  await page.evaluate(() => window.performanceFixture.render({ code: "const latest = 2;\n" }));
  await page.waitForFunction(() =>
    window.performanceFixture.status().content.includes("const latest = 2;"),
  );
  assert.equal(
    (await page.evaluate(() => window.performanceFixture.status())).content.includes(
      "const latest = 1;",
    ),
    false,
  );
  await page.evaluate(() => window.performanceFixture.render({ open: true }));
  assert.equal(
    await page.locator('[data-testid="chat-reasoning-content"]').textContent(),
    `首行\r\n尾行${"字".repeat(30)}\r\n\r\n`,
  );
  await page.screenshot({
    path: join(evidenceDir, "components-expanded.png"),
    animations: "disabled",
  });
  await page.evaluate(() =>
    window.performanceFixture.render({
      streaming: false,
      theme: "github-dark",
      language: "javascript",
    }),
  );
  await page.waitForFunction(() =>
    window.performanceFixture.status().content.includes("const latest = 2;"),
  );
  await page.waitForFunction(() => {
    const { tokens } = window.performanceFixture.highlightInspection();
    return (
      tokens.some((token) => token.text === "const") &&
      new Set(tokens.map((token) => token.color)).size > 1
    );
  });
  const darkHighlight = await page.evaluate(() => window.performanceFixture.highlightInspection());
  const darkKeyword = darkHighlight.tokens.find((token) => token.text === "const").color;
  const highlighterWorkers = page
    .workers()
    .map((worker) => worker.url())
    .filter((url) => url.includes("diffs.worker"));
  assert.ok(
    highlighterWorkers.length > 0,
    "The actual product highlighter Worker pool must be running",
  );
  await page.evaluate(() => {
    // 只记录实际复制按钮交付的内容，不替换 CodeBlock 上下文或产品复制回调。
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedCode = text;
        },
      },
    });
  });
  await page.getByRole("button", { name: "复制代码", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedCode), "const latest = 2;\n");
  assert.equal(
    await page.evaluate(() => window.codeIdentity === document.querySelector("diffs-container")),
    true,
  );
  assert.deepEqual((await page.evaluate(() => window.performanceFixture.status())).errors, []);
  evidence.push({
    event: "complete-theme-language-copy",
    latestCode: "const latest = 2;\n",
    clipboardBoundary: "recording-port",
    stableContainer: true,
    actualWorkerTokenHighlighting: true,
    darkHighlight,
    highlighterWorkerCount: highlighterWorkers.length,
  });
  await page.screenshot({
    path: join(evidenceDir, "components-complete-dark.png"),
    animations: "disabled",
  });
  await page.evaluate(() => window.performanceFixture.render({ theme: "github-light" }));
  await page.waitForFunction((before) => {
    const keyword = window.performanceFixture
      .highlightInspection()
      .tokens.find((token) => token.text === "const");
    return keyword && keyword.color !== before;
  }, darkKeyword);
  const lightHighlight = await page.evaluate(() => window.performanceFixture.highlightInspection());
  assert.notEqual(lightHighlight.tokens.find((token) => token.text === "const").color, darkKeyword);
  assert.notEqual(
    lightHighlight.background,
    darkHighlight.background,
    "The real code background must change with the selected theme",
  );
  evidence.at(-1).lightHighlight = lightHighlight;
  evidence.at(-1).actualLightDarkColors = true;
  await page.screenshot({
    path: join(evidenceDir, "components-complete-light.png"),
    animations: "disabled",
  });
  await page.evaluate(() =>
    window.performanceFixture.render({
      mode: "timeline",
      theme: "github-light",
      streaming: true,
      rows: Array.from({ length: 20 }, (_, index) =>
        window.performanceFixture.turnRows(index + 1, index === 19),
      ).flat(),
      findQuery: "question-",
    }),
  );
  const navigator = page.getByTestId("v4-turn-navigator");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-turn-navigator"]')
        ?.getAttribute("data-item-count") === "20",
  );
  const activeTurn = page.locator('[data-turn-key][data-turn-id="fixture-turn-20"]');
  await activeTurn.waitFor({ state: "visible" });
  const beforeClock = await activeTurn.innerText();
  const beforeFind = await page.evaluate(() => window.performanceFixture.timeline().find);
  await page.waitForTimeout(2_200);
  assert.notEqual(
    await activeTurn.innerText(),
    beforeClock,
    "Running work duration must advance in the real DOM",
  );
  assert.equal(await navigator.getAttribute("data-item-count"), "20");
  assert.deepEqual(
    await page.evaluate(() => window.performanceFixture.timeline().find),
    beforeFind,
  );
  await page.evaluate(() => {
    const rows = [...window.performanceFixture.state().rows];
    rows[rows.length - 1] = { ...rows[rows.length - 1], text: "answer-20-latest-keyword" };
    window.performanceFixture.render({ rows, findQuery: "latest-keyword" });
  });
  await page.getByText("answer-20-latest-keyword", { exact: true }).waitFor();
  await page.waitForFunction(() => window.performanceFixture.timeline().find?.matchCount === 1);
  await page.evaluate(() => window.performanceFixture.render({ canLoadOlder: true }));
  const metrics = await page
    .getByTestId("v4-timeline")
    .evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  assert.ok(
    metrics.height <= 720 && metrics.scrollHeight > metrics.height,
    "The real timeline must have a bounded scroll viewport",
  );
  await page.getByTestId("v4-timeline").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForFunction(() => window.performanceFixture.timeline().olderLoads === 1);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-turn-navigator"]')
        ?.getAttribute("data-item-count") === "21",
  );
  // 新页保留当前阅读锚点；通过既有问题导航定位首轮后核对前插正文。
  await page
    .locator('[data-testid^="v4-turn-navigator-item-"][data-turn-id="fixture-turn-0"]')
    .click();
  await page.getByTestId("v4-row-1").getByText("question-0", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.performanceFixture.state().rows))[0].turnId,
    "fixture-turn-0",
  );
  assert.deepEqual((await page.evaluate(() => window.performanceFixture.status())).errors, []);
  evidence.push({
    event: "timeline-clock-stream-pagination",
    turnsBefore: 20,
    turnsAfter: 21,
    realLoadOlder: true,
    clockAdvances: true,
    findUpdated: true,
  });
  await page.screenshot({
    path: join(evidenceDir, "components-timeline-paged.png"),
    animations: "disabled",
  });
  if (!options.skipComposer) await runComposerAssertions(page, evidenceDir, evidence);
  await page.evaluate(() => window.performanceFixture.render({ mode: "file-provider" }));
  const liveQuery = page.getByTestId("provider-live-query");
  await page.waitForFunction(
    () =>
      window.fileProviderFixture?.status().requests.filter((request) => request.params.refresh)
        .length === 1,
  );
  await page.evaluate(() => window.fileProviderFixture.addFile("fresh-file.txt"));
  await liveQuery.fill("");
  await liveQuery.fill("fresh-file");
  assert.equal(
    (await page.evaluate(() => window.fileProviderFixture.status())).deferred,
    "miss-first",
  );
  assert.equal(
    (await page.evaluate(() => window.fileProviderFixture.status())).requests.filter(
      (request) => request.params.refresh,
    ).length,
    1,
    "A stale deferred query cannot consume the new raw-input refresh round",
  );
  await page.evaluate(() => window.fileProviderFixture.consume("fresh-file"));
  await page.getByTestId("provider-results").getByText("fresh-file.txt", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.fileProviderFixture.status())).requests.filter(
      (request) => request.params.refresh,
    ).length,
    2,
  );
  await liveQuery.fill("");
  await page.evaluate(() => window.fileProviderFixture.consume(""));
  await page.waitForFunction(() =>
    window.fileProviderFixture
      .status()
      .requests.some((request) => !request.params.query && !request.completed),
  );
  await liveQuery.fill("fresh-file");
  await page.evaluate(() => window.fileProviderFixture.consume("fresh-file"));
  await page.getByTestId("provider-results").getByText("fresh-file.txt", { exact: true }).waitFor();
  await page.evaluate(() => window.fileProviderFixture.releaseEmpty());
  await page.waitForTimeout(60);
  assert.equal(await page.getByText("wrong-old-result", { exact: true }).count(), 0);
  assert.equal(
    (await page.evaluate(() => window.fileProviderFixture.status())).requests.filter(
      (request) => request.params.refresh,
    ).length,
    3,
  );
  evidence.push({
    event: "file-provider-live-deferred-rounds",
    realHook: true,
    staleDeferredDoesNotConsumeRefresh: true,
    emptyRpcLateResultIgnored: true,
    freshFileFound: true,
    serviceBoundary: "controlled-port",
  });
  if (!options.skipComposer) await runDraftHookAssertions(page, evidence);
}
