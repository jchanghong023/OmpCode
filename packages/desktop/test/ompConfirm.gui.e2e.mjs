import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
const workspace = process.env.OMP_E2E_WORKSPACE;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
assert.ok(workspace, "Set OMP_E2E_WORKSPACE to a workspace with ompConfirmExtension.js installed");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => /^http:\/\/(?:localhost|127\.0\.0\.1):5194\//u.test(candidate.url()));
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  page.setDefaultTimeout(20_000);

  for (const [choice, expected] of [
    ["accept", "accepted"],
    ["decline", "declined"],
  ]) {
    await page.getByTestId("v4-composer-input").fill(`/gui-confirm-e2e ${choice}`);
    await page.getByTestId("v4-composer-send").click();
    const dialog = page.getByTestId("v4-user-input-dialog");
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.innerText(), new RegExp(`Confirm ${choice}\\?`, "u"));
    await dialog.getByRole("button", { name: choice === "accept" ? "确认" : "拒绝" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="v4-composer-send"]') !== null,
      undefined,
      {
        timeout: 20_000,
      },
    );
    const resultPath = join(workspace, `gui-confirm-${choice}.txt`);
    let actual;
    for (let attempt = 0; attempt < 50; attempt++) {
      actual = await readFile(resultPath, "utf8").catch(() => undefined);
      if (actual !== undefined) break;
      await sleep(100);
    }
    assert.equal(actual, expected);
  }
  console.log("omp GUI confirm: accept and decline both reached the extension");
} finally {
  await browser.close();
}
