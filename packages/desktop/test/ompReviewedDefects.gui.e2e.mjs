import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
const runId = process.env.OMP_E2E_RUN_ID;
assert.ok(runId, "Set OMP_E2E_RUN_ID to a unique test marker");
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(phase === "live" || phase === "recovery", "OMP_E2E_PHASE must be live or recovery");
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
assert.ok(evidenceDir, "Set OMP_E2E_EVIDENCE_DIR for live and same-root recovery evidence");
const identityReceipt = join(evidenceDir, `reviewed-defects-${runId}.json`);
// 配置存在时只连接 fixture 的 renderer；无配置的手动入口保留原来的两种回环主机。
const rendererUrl =
  process.env.OMP_E2E_RENDERER_URL ??
  (process.env.OMP_E2E_RUNTIME_MANIFEST
    ? JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8")).rendererUrl
    : undefined);
const rendererPrefix = rendererUrl ? `${rendererUrl.replace(/\/+$/u, "")}/` : undefined;

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) =>
      rendererPrefix
        ? candidate.url().startsWith(rendererPrefix)
        : /^http:\/\/(?:localhost|127\.0\.0\.1):5194\//u.test(candidate.url()),
    );
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
    return marker;
  }

  const taskRows = page.locator('li[data-testid^="task-item-"]');
  const readTaskIds = () =>
    taskRows.evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  // OMP 标题真实截断到 60 字再加省略号；身份验收不能按完整提示词或自动标题定位。
  const saved = phase === "recovery" ? JSON.parse(await readFile(identityReceipt, "utf8")) : null;
  if (saved) assert.equal(saved.runId, runId, "Recovery must consume this exact live attempt");
  const before = saved?.before ?? (await readTaskIds());
  if (phase === "live") await sendAndWait(`GUI_IDENTITY_FIRST_${runId}`);
  await page.waitForFunction((previous) => {
    const created = [...document.querySelectorAll('li[data-testid^="task-item-"]')]
      .map((item) => item.getAttribute("data-testid"))
      .filter((id) => !previous.includes(id));
    return (
      created.length === 1 && /^task-item-[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(created[0] ?? "")
    );
  }, before);
  const created = (await readTaskIds()).filter((id) => !before.includes(id));
  assert.equal(created.length, 1, "One conversation must have one sidebar task");
  const taskTestId = created[0];
  if (saved) assert.equal(taskTestId, saved.taskTestId, "Cold recovery must keep the live UUID");
  const matchingTask = page.getByTestId(taskTestId);
  await matchingTask.click();
  await page
    .getByText(`GUI_IDENTITY_FIRST_${runId}`, { exact: true })
    .waitFor({ state: "visible" });
  if (phase === "live") {
    await sendAndWait(`GUI_IDENTITY_SECOND_${runId}`);
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  } else {
    await page
      .getByText(`GUI_IDENTITY_SECOND_${runId}`, { exact: true })
      .waitFor({ state: "visible" });
  }
  assert.equal(
    (await readTaskIds()).filter((id) => !before.includes(id)).length,
    1,
    "A later turn must not revive the temporary task ID",
  );
  assert.equal(await matchingTask.getAttribute("data-testid"), taskTestId);
  if (phase === "live") {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(identityReceipt, JSON.stringify({ runId, before, taskTestId }, null, 2));
  }
  await captureIsolationScreenshot(join(evidenceDir, `identity-${phase}-${runId}.png`));
  console.log(
    `omp GUI identity ${phase}: glm-5.3-flash replies visible; stable task ${taskTestId}`,
  );
} finally {
  await browser.close();
}
