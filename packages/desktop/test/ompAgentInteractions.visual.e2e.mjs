// 已保存测试会话的纯GUI视觉验收；不执行模型、不写入会话或用户配置。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const manifest = process.env.OMP_E2E_RUNTIME_MANIFEST;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const marker = process.env.OMP_E2E_RUN_ID;
assert.ok(manifest && evidenceDir && marker);
const runtime = JSON.parse(await readFile(manifest, "utf8"));
const browser = await chromium.connectOverCDP(runtime.endpoint);
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((item) => item.url().startsWith(runtime.rendererUrl));
  assert.ok(page);
  page.setDefaultTimeout(30_000);
  await page.locator('li[data-testid^="task-item-"]').filter({ hasText: marker }).first().click();
  const expand = page.getByRole("button", { name: "展开状态", exact: true });
  if (await expand.isVisible()) await expand.click();
  const section = page.locator('[data-status-section-trigger="agent"]');
  if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
  await page.getByTestId("omp-agent-interactions-open").click();
  const view = page.getByTestId("omp-agent-interactions");
  await view.waitFor({ state: "visible" });
  const search = page.getByTestId("omp-agent-interactions-search");
  await search.fill(`${marker}_MAIN_TO_ALPHA`);
  const message = page
    .locator('[data-testid="omp-agent-interaction-message"][data-kind="message"]')
    .filter({ hasText: `${marker}_MAIN_TO_ALPHA` })
    .first();
  await message.click();
  const detail = page.getByTestId("omp-agent-interaction-detail");
  assert.equal(await detail.getAttribute("data-from"), "main");
  assert.equal(await detail.getAttribute("data-to"), "InteractionAlpha");
  // 用结果标记及真实发送方定位；不能依赖另一条消息搜索后碰巧排第一。
  await search.fill("ALPHA_DONE");
  await page
    .locator(
      '[data-testid="omp-agent-interaction-message"][data-kind="task_result"][data-from="InteractionAlpha"]',
    )
    .first()
    .click();
  const original = detail.getByTestId("omp-agent-interaction-original-body");
  const sourceBody = await original.textContent();
  assert.ok(sourceBody?.startsWith("<task-result"));
  const sourceStatus = /\bstatus="([^"]+)"/u.exec(sourceBody)?.[1];
  const sourceDuration = /\bduration="([^"]+)"/u.exec(sourceBody)?.[1];
  const outputText = /<output>\s*([\s\S]*?)\s*<\/output>/u.exec(sourceBody)?.[1];
  assert.ok(outputText);
  let data = null;
  try {
    data = JSON.parse(outputText);
  } catch {
    /* 原输出不一定是JSON。 */
  }
  const summary = detail.getByTestId("omp-agent-interaction-summary");
  const summaryText = await summary.innerText();
  const statusLabels = {
    completed: "已完成",
    success: "已完成",
    failed: "失败",
    cancelled: "已取消",
    aborted: "已中止",
  };
  if (sourceStatus) assert.ok(summaryText.includes(statusLabels[sourceStatus] ?? sourceStatus));
  const durationParts = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/u.exec(sourceDuration ?? "");
  if (durationParts) {
    const units = { ms: "毫秒", s: "秒", m: "分钟", h: "小时" };
    assert.ok(
      summaryText.includes(`${Number(durationParts[1])} ${units[durationParts[2]]}`),
      "Show the duration supplied by this actual task result",
    );
  }
  const displayedFields = await summary.locator("dl > div").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.querySelector("dt")?.textContent,
      value: element.querySelector("dd")?.textContent,
    })),
  );
  const object = data && typeof data === "object" && !Array.isArray(data) ? data : null;
  const failed = [sourceStatus, object?.status].some(
    (value) =>
      typeof value === "string" && /^(?:error|failed|failure|aborted|cancelled)$/iu.test(value),
  );
  const resultValues = object
    ? [object.summary, object.result, object.output, object.message, object.error, object.status]
    : [];
  const result = object
    ? (failed ? [object.error, ...resultValues] : resultValues).find(
        (value) => typeof value === "string" && value.trim(),
      )
    : null;
  if (result)
    assert.ok(displayedFields.some((field) => field.label === "结果" && field.value === result));
  const childResults = object
    ? Object.entries(object).filter(
        ([key, value]) =>
          key.endsWith("_result") && typeof value === "string" && !/(?:id|trace|marker)/u.test(key),
      )
    : [];
  if (childResults.length)
    assert.ok(
      displayedFields.some(
        (field) => field.label === "子结果" && field.value === childResults[0][1],
      ),
    );
  else
    assert.equal(
      displayedFields.some((field) => field.label === "子结果"),
      false,
      "Do not create a child result absent from the source",
    );
  const reportedCount = Array.isArray(object?.messages_sent)
    ? object.messages_sent.length
    : Number.isSafeInteger(object?.messages_sent)
      ? object.messages_sent
      : null;
  if (reportedCount !== null)
    assert.ok(
      displayedFields.some(
        (field) => field.label === "报告发送" && field.value === `${reportedCount} 条`,
      ),
    );
  else
    assert.equal(
      displayedFields.some((field) => field.label === "报告发送"),
      false,
      "Do not create a reported send count absent from the source",
    );
  assert.doesNotMatch(
    await detail.innerText(),
    /<task-result|<output>|agent:\/\/|OMP_INTERACTIONS|"gamma_received_marker"/u,
  );
  assert.equal(await original.isVisible(), false);
  await detail.screenshot({
    path: join(evidenceDir, "visual-result-summary.png"),
    animations: "disabled",
  });
  await detail.getByTestId("omp-agent-interaction-raw-toggle").click();
  assert.equal(await original.isVisible(), true);
  const originalBody = await original.innerText();
  assert.equal(originalBody, sourceBody, "Expanding preserves the complete source body exactly");
  await detail.screenshot({
    path: join(evidenceDir, "visual-result-original.png"),
    animations: "disabled",
  });
  await detail.getByTestId("omp-agent-interaction-raw-toggle").click();
  assert.equal(await original.isVisible(), false);
  const originalViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  async function selectTheme(scheme) {
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    if (isDark === (scheme === "dark")) return;
    const preferences = page.getByTestId("sidebar-preferences-trigger").first();
    if (!(await preferences.isVisible())) await page.getByTestId("sidebar-toggle").click();
    await preferences.click();
    await page.getByRole("menuitem", { name: "界面主题", exact: true }).click();
    await page
      .getByRole("menuitemradio", {
        name: scheme === "dark" ? "深色主题" : "浅色主题",
        exact: true,
      })
      .click();
  }
  const evidence = [];
  for (const [name, width, scheme] of [
    ["wide-dark", 1800, "dark"],
    ["wide-light", 1800, "light"],
    ["narrow-light", 1000, "light"],
  ]) {
    // Electron未实现Browser.setWindowBounds；用Chromium视口驱动真实renderer响应式布局。
    await page.setViewportSize({ width, height: 900 });
    await selectTheme(scheme);
    await page.waitForTimeout(400);
    // 响应式外壳可能自动收起侧栏；公开按钮重新展开后才检查页面。
    if ((await view.count()) === 0) await page.getByTestId("side-pane-toggle").click();
    await view.waitFor({ state: "visible" });
    // 收起卸载后页面选择态会重建；通过真实搜索和点击保持截图选择同一消息。
    await page.getByTestId("omp-agent-interactions-search").fill(`${marker}_MAIN_TO_ALPHA`);
    await page
      .locator('[data-testid="omp-agent-interaction-message"][data-kind="message"]')
      .filter({ hasText: `${marker}_MAIN_TO_ALPHA` })
      .first()
      .click();
    assert.equal(await detail.getAttribute("data-from"), "main");
    assert.equal(await detail.getAttribute("data-to"), "InteractionAlpha");
    await page.getByTestId("omp-agent-interactions-view").evaluate((element) => {
      element.scrollTop = 0;
    });
    const dimensions = await view.evaluate((element) => {
      const detail = element.querySelector('[data-testid="omp-agent-interaction-detail"]');
      return {
        width: element.clientWidth,
        detailWidth: detail.clientWidth,
        detailScrollWidth: detail.scrollWidth,
        theme: document.documentElement.className,
        background: getComputedStyle(
          element.querySelector('[data-testid="omp-agent-interactions-view"]'),
        ).backgroundColor,
        graph: (() => {
          const graph = element.querySelector('[data-testid="omp-agent-interaction-graph"]');
          const bounds = graph.getBoundingClientRect();
          return {
            width: graph.clientWidth,
            height: graph.clientHeight,
            scrollWidth: graph.scrollWidth,
            scrollHeight: graph.scrollHeight,
            nodes: [...graph.querySelectorAll('[data-testid="omp-agent-interaction-node"]')].map(
              (node) => {
                const rect = node.getBoundingClientRect();
                return {
                  id: node.getAttribute("data-agent-id"),
                  caption: node.textContent,
                  inside:
                    rect.left >= bounds.left - 1 &&
                    rect.right <= bounds.right + 1 &&
                    rect.top >= bounds.top - 1 &&
                    rect.bottom <= bounds.bottom + 1,
                  fontSize: getComputedStyle(node.querySelector("span")).fontSize,
                };
              },
            ),
          };
        })(),
      };
    });
    assert.ok(dimensions.width > 0 && dimensions.detailWidth > 0);
    assert.ok(
      dimensions.detailScrollWidth <= dimensions.detailWidth + 1,
      "Message content must wrap within the narrow pane",
    );
    assert.equal(dimensions.graph.nodes.length, 4);
    assert.ok(
      dimensions.graph.nodes.every((node) => node.inside),
      "All four real nodes must fit within the graph viewport",
    );
    assert.ok(dimensions.graph.scrollWidth <= dimensions.graph.width + 1);
    assert.ok(dimensions.graph.scrollHeight <= dimensions.graph.height + 1);
    await view.screenshot({
      path: join(evidenceDir, `visual-${name}.png`),
      animations: "disabled",
    });
    evidence.push({ name, ...dimensions });
  }
  assert.notEqual(
    evidence[0].background,
    evidence[1].background,
    "The product must actually respond to light/dark themes",
  );
  assert.deepEqual(
    evidence[0].graph.nodes.map((node) => node.fontSize),
    evidence[2].graph.nodes.map((node) => node.fontSize),
    "Fitting the narrow graph must not shrink the node font",
  );
  await page.setViewportSize(originalViewport);
  await selectTheme("dark");
  await page
    .locator('[data-side-pane-tab-id^="omp-agent-interactions:"]')
    .first()
    .getByRole("button", { name: /关闭/u })
    .click();
  await view.waitFor({ state: "detached" });
  await writeFile(join(evidenceDir, "visual-result.json"), JSON.stringify(evidence, null, 2));
  await writeFile(
    join(evidenceDir, "summary-result.json"),
    JSON.stringify({ summaryText, originalBodyPreserved: true, collapsedAgain: true }, null, 2),
  );
  console.log("PASS visual: actual light/dark themes and wrapping in a narrow pane");
} finally {
  await browser.close();
}
