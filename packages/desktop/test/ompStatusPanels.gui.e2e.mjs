// 隔离 Windows 桌面的真实 OMP/模型验收；只通过现有 GUI 入口操作，不注入会话状态。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const phase = process.env.OMP_E2E_PHASE ?? "live";
// 固定 renderer 端口会绕过隔离 fixture；显式 URL 优先，manifest 提供准备器的真实来源。
const rendererUrl =
  process.env.OMP_E2E_RENDERER_URL ??
  (process.env.OMP_E2E_RUNTIME_MANIFEST
    ? JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8")).rendererUrl
    : undefined) ??
  "http://localhost:5194";
const rendererPrefix = `${rendererUrl.replace(/\/+$/u, "")}/`;
assert.ok(endpoint && evidenceDir, "Specify an isolated CDP endpoint and evidence directory");
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find((candidate) => candidate.url().startsWith(rendererPrefix));
assert.ok(page, "Expected the isolated desktop renderer");
page.setDefaultTimeout(30_000);
const marker = "OMP_UI_PANELS_20261008";
const evidence = [];
const shot = (name) =>
  page.screenshot({ path: join(evidenceDir, `${phase}-${name}.png`), animations: "disabled" });
async function send(text) {
  await page.getByTestId("v4-composer-input").first().fill(text);
  await page.getByTestId("v4-composer-send").first().click();
}
async function expandStatus() {
  const expand = page.getByRole("button", { name: "展开状态", exact: true });
  if (await expand.isVisible()) await expand.click();
}
try {
  if (phase === "live") {
    await page.getByRole("button", { name: "新建任务", exact: true }).last().click();
    const model = page.getByTestId("chat-model-select-trigger");
    await model.waitFor({ state: "visible" });
    if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
      await model.click();
      await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
      await page
        .getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash")
        .click();
    }
    await send(
      `${marker}：只执行只读 GUI 验收，不修改任何文件。先用 todo 创建三项：UI_ALPHA、UI_BETA、UI_DONE，将 UI_ALPHA 标为进行中。用 task 工具一次并行启动两个 task 子代理：一个通过 bash 调用 powershell -NoProfile -Command "Start-Sleep -Seconds 15; Write-Output UI_ALPHA"，另一个通过 bash 调用 powershell -NoProfile -Command "Start-Sleep -Seconds 20; Write-Output UI_BETA"；每个子代理最终只回复对应标记。务必等待两个子代理完成，再将全部 todo 标为 completed，最终回复 UI_ACCEPTANCE_DONE。`,
    );
    let sawTwo = false;
    let sawTodo = false;
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      const state = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="chat-summary-panel"]');
        return {
          running: Number(panel?.getAttribute("data-running-agent-count") ?? 0),
          todos: Array.from(
            document.querySelectorAll('[data-status-section="plan"] [data-plan-status]'),
          ).map((item) => ({
            status: item.getAttribute("data-plan-status"),
            text: item.textContent,
          })),
        };
      });
      if (!sawTodo && state.todos.length === 3) {
        sawTodo = true;
        await expandStatus();
        await page.locator('[data-status-section="plan"]').waitFor({ state: "visible" });
        await shot("todo-running");
        evidence.push({ event: "todo-running", ...state });
      }
      if (!sawTwo && state.running === 2) {
        sawTwo = true;
        await expandStatus();
        const agents = page.locator('[data-status-section-trigger="agent"]');
        if ((await agents.count()) && (await agents.getAttribute("aria-expanded")) !== "true")
          await agents.click();
        await shot("agents-running");
        evidence.push({ event: "two-running", ...state });
      }
      if (
        state.running === 0 &&
        state.todos.length === 3 &&
        state.todos.every((item) => item.status === "completed")
      )
        break;
      await page.waitForTimeout(200);
    }
    assert.ok(sawTodo, "Expected the independent Todo panel during the real task");
    assert.ok(sawTwo, "Expected two concurrent subagents in the independent panel");
    await page
      .getByText("UI_ACCEPTANCE_DONE", { exact: true })
      .first()
      .waitFor({ state: "visible" });
  } else {
    await page.locator('li[data-testid^="task-item-"]').filter({ hasText: marker }).first().click();
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-status-section="plan"] [data-plan-status="completed"]')
        .length === 3,
  );
  await expandStatus();
  await page.locator('[data-status-section="plan"]').waitFor({ state: "visible" });
  const agents = page.locator('[data-status-section-trigger="agent"]');
  if ((await agents.getAttribute("aria-expanded")) !== "true") await agents.click();
  await page
    .locator('[data-status-section="agent"]')
    .getByRole("button", { name: /已结束.*2/u })
    .waitFor({ state: "visible" });
  // 工作组可折叠；独立待办面板仍然存在，主对话 Agent 卡片通过既有打开入口呈现。
  for (const button of await page
    .getByRole("button")
    .filter({ hasText: /已工作|已处理/u })
    .all()) {
    if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  }
  const cards = page.locator('[data-testid^="v4-subagent-open-side-pane-"]');
  await cards.first().waitFor({ state: "visible" });
  assert.equal(await cards.count(), 2, "Expected one Agent card per subagent");
  const ids = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  assert.equal(new Set(ids).size, 2);
  assert.equal(
    await page
      .locator('[data-testid="chat-summary-panel"]')
      .getAttribute("data-running-agent-count"),
    "0",
  );
  await shot("completed");
  for (let index = 0; index < 2; index++) {
    const card = cards.nth(index);
    const expected = (await card.innerText()).includes("UI_ALPHA") ? "UI_ALPHA" : "UI_BETA";
    await card.click();
    const viewId = ids[index].slice("v4-subagent-open-side-pane-".length);
    const detail = page.locator(`[data-subagent-session-id="${viewId}"]`);
    await detail.waitFor({ state: "visible" });
    for (const button of await detail
      .getByRole("button")
      .filter({ hasText: /已工作|已处理/u })
      .all()) {
      if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
    }
    const tool = detail.getByRole("button", { name: "展开工具详情", exact: true }).first();
    if (await tool.isVisible()) await tool.click();
    // 只在子代理详情内检查实际工具输出；不能用主对话 Todo 或请求正文中的标记冒充结果。
    await detail
      .getByText(new RegExp(`^${expected}(?:\\s|$)`, "u"))
      .first()
      .waitFor({ state: "visible" });
    await shot(`detail-${index}`);
  }
  evidence.push({ event: `${phase}-completed`, cardIds: ids, result: "passed" });
  await writeFile(join(evidenceDir, `${phase}-result.json`), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${phase}: independent Todo, two subagent cards, completed state and detail`);
} finally {
  await browser.close();
}
