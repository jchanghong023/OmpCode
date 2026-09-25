import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
const phase = process.env.OMP_E2E_PROFILE_PHASE;
assert.ok(phase === "before" || phase === "after", "Set OMP_E2E_PROFILE_PHASE to before or after");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts()[0]?.pages().find((candidate) =>
    candidate.url().startsWith("http://127.0.0.1:"),
  );
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  const profileInfo = await page.evaluate(() => window.zcode.listOmpProfiles());
  assert.equal(profileInfo.success, true);
  assert.ok(profileInfo.profiles.includes("codex-e2e"));

  const section = page.getByTestId("omp-model-roles-section");
  if (!(await page.getByRole("combobox", { name: "OMP Profile" }).isVisible().catch(() => false))) {
    await page.getByTestId("task-settings-button").click({ force: true });
    await page.getByRole("button", { name: "模型设置" }).click();
  }
  const selector = page.getByRole("combobox", { name: "OMP Profile" });
  await selector.waitFor({ state: "visible" });

  if (phase === "before") {
    assert.equal(profileInfo.activeProfile, "default");
    assert.equal(await selector.inputValue(), "default");
    const oldRoles = await page.evaluate(() => window.zcode.readOmpModelRoles());
    assert.equal(oldRoles.success, true);
    assert.equal(oldRoles.roles.some((role) => role.role === "profileMarker"), false);
    await selector.selectOption("codex-e2e");
    await page.getByText("Profile 已保存。请重启应用后使用该 profile 的配置、模型和会话。").waitFor();
    assert.equal(await section.count(), 0, "pending restart must block writing the old profile");
    const beforeRestart = await page.evaluate(() => window.zcode.readOmpModelRoles());
    assert.equal(beforeRestart.success, true);
    assert.equal(beforeRestart.roles.some((role) => role.role === "profileMarker"), false);
    console.log("omp GUI profile: saved selection; old profile remains active until restart");
  } else {
    assert.equal(profileInfo.activeProfile, "codex-e2e");
    assert.equal(await selector.inputValue(), "codex-e2e");
    await section.waitFor({ state: "visible" });
    const namedRoles = await page.evaluate(() => window.zcode.readOmpModelRoles());
    assert.equal(namedRoles.success, true);
    assert.equal(namedRoles.roles.some((role) => role.role === "profileMarker"), true);
    assert.equal(await page.getByText("Profile 已保存。请重启应用后使用该 profile 的配置、模型和会话。").count(), 0);
    console.log("omp GUI profile: named config active after restart");
  }
} finally {
  await browser.close();
}
