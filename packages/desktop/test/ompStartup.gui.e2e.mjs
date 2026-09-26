import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("http://127.0.0.1:"));
  assert.ok(page, "Expected an isolated OmpCode renderer page");

  // 旧 Provider Registry 为空也要加载 omp；不能再显示 ZCode 套餐/供应商横幅。
  await assert.doesNotReject(() =>
    page.getByText("当前没有可用模型。请开通编程套餐或配置自定义模型。").waitFor({
      state: "hidden",
      timeout: 15_000,
    }),
  );

  const section = page.getByTestId("omp-model-roles-section");
  if (!(await section.isVisible())) {
    const settingsButtons = page.getByRole("button", { name: "设置" });
    if ((await settingsButtons.count()) > 1) {
      await settingsButtons.last().click();
    }
    await page.getByRole("button", { name: "模型设置" }).click();
  }
  await section.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      (document.querySelector(
        '[data-testid="omp-model-roles-section"] select[aria-label="default"]',
      )?.options.length ?? 0) > 1,
  );
  // 已配置的 role 可以引用当前目录外的模型；原值仍需可见，供用户换到已有模型。
  assert.match(await section.innerText(), /commandcode\/inclusionai\/ling-3\.0-flash-sante:free/u);
  assert.ok(
    (await section.getByRole("combobox", { name: "default" }).locator("option").count()) > 1,
    "Expected models from the omp catalog",
  );
  assert.equal(await page.getByText("添加供应商", { exact: true }).count(), 0);
  console.log("omp GUI startup: legacy banner absent; settings page edits omp roles");
} finally {
  await browser.close();
}
