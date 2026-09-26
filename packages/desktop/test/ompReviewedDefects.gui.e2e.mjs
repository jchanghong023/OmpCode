import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
const runId = process.env.OMP_E2E_RUN_ID;
assert.ok(runId, "Set OMP_E2E_RUN_ID to a unique test marker");
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(phase === "live" || phase === "recovery", "OMP_E2E_PHASE must be live or recovery");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => /^http:\/\/(?:localhost|127\.0\.0\.1):5194\//u.test(candidate.url()));
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  page.setDefaultTimeout(30_000);

  const model = page.getByTestId("chat-model-select-trigger");
  await model.waitFor({ state: "visible" });
  if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
    await model.click();
    await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
    await page.getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash").click();
  }
  assert.equal(await model.getAttribute("aria-label"), "zhipu-coding-plan/GLM-5.3-Flash");

  async function sendAndWait(marker) {
    const prompt = `请只回复 ${marker}，不要使用工具。`;
    await page.getByTestId("v4-composer-input").fill(prompt);
    await page.getByTestId("v4-composer-send").click();
    await page.getByText(marker, { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible", timeout: 30_000 });
    return prompt;
  }

  const firstPrompt = `请只回复 GUI_IDENTITY_FIRST_${runId}，不要使用工具。`;
  if (phase === "live") {
    await sendAndWait(`GUI_IDENTITY_FIRST_${runId}`);
    // 首轮终态会把临时 ID 迁到 omp UUID；在途 readSession 也不能重新造回临时行。
    await page.waitForTimeout(2_000);
  }
  const matchingTasks = page
    .locator('li[data-testid^="task-item-"]')
    .filter({ hasText: firstPrompt });
  await matchingTasks.first().waitFor({ state: "visible" });
  assert.equal(await matchingTasks.count(), 1, "One conversation must have one sidebar task");
  const taskTestId = await matchingTasks.first().getAttribute("data-testid");
  assert.match(taskTestId ?? "", /^task-item-[0-9a-f]{8}-[0-9a-f-]{27,}$/iu);

  await matchingTasks.first().click();
  await page
    .getByText(`GUI_IDENTITY_FIRST_${runId}`, { exact: true })
    .waitFor({ state: "visible" });
  if (phase === "live") {
    await sendAndWait(`GUI_IDENTITY_SECOND_${runId}`);
    await page.waitForTimeout(2_000);
  } else {
    await page
      .getByText(`GUI_IDENTITY_SECOND_${runId}`, { exact: true })
      .waitFor({ state: "visible" });
  }
  assert.equal(
    await matchingTasks.count(),
    1,
    "A later turn must not revive the temporary task ID",
  );
  assert.equal(await matchingTasks.first().getAttribute("data-testid"), taskTestId);
  assert.equal(await page.locator('[data-testid^="v4-feedback-like"]').count(), 0);
  assert.equal(await page.locator('[data-testid^="v4-feedback-dislike"]').count(), 0);
  console.log(
    `omp GUI identity ${phase}: glm-5.3-flash replies visible; stable task ${taskTestId}`,
  );
} finally {
  await browser.close();
}
