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
    // 设置入口已统一为侧栏按钮；不能因只剩一个按钮而跳过真实用户操作。
    await page.getByRole("button", { name: "设置", exact: true }).last().click();
    await page.getByRole("button", { name: "模型设置" }).click();
  }
  await section.waitFor({ state: "visible" });
  // 原生 select/options 已由共享 Select 替换；验证实际可用候选，而不是控件内部标签。
  const defaultRole = section.getByRole("combobox", { name: "default", exact: true });
  await defaultRole.waitFor({ state: "visible" });
  // 已配置的 role 可以引用当前目录外的模型；原值仍需可见，供用户换到已有模型。
  assert.match(
    await defaultRole.innerText(),
    /commandcode\/inclusionai\/ling-3\.0-flash-sante:free/u,
  );
  await defaultRole.click();
  await page
    .getByRole("option", { name: /GLM-5\.3-Flash/u })
    .first()
    .waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByText("添加供应商", { exact: true }).count(), 0);
  console.log("omp GUI startup: legacy banner absent; settings page edits omp roles");
} finally {
  await browser.close();
}
