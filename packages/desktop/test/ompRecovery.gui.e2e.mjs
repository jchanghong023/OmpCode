import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
const workspace = process.env.OMP_E2E_WORKSPACE;
assert.ok(workspace, "Set OMP_E2E_WORKSPACE to the isolated test workspace");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("http://127.0.0.1:"));
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  page.setDefaultTimeout(10_000);
  const back = page.getByTestId("settings-back-button");
  if (await back.isVisible()) {
    await back.click({ force: true });
  }
  const task = page
    .locator('li[data-testid^="task-item-"]')
    .filter({ hasText: "gui-e2e-omp.txt" })
    .first();
  await task.waitFor({ state: "visible" });
  await task.click({ force: true });
  const rows = page.locator('[data-testid^="v4-row-"]');
  await rows.filter({ hasText: "omp gui e2e passed" }).first().waitFor({ state: "visible" });
  await rows.filter({ hasText: "OK" }).first().waitFor({ state: "visible" });
  assert.equal(await readFile(join(workspace, "gui-e2e-omp.txt"), "utf8"), "omp gui e2e passed");
  console.log("omp GUI cold recovery: persisted message and tool result are visible");
} finally {
  await browser.close();
}
