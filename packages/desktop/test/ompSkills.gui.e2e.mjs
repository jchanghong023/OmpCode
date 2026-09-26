import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
const workspacePath = process.env.OMP_E2E_WORKSPACE_PATH;
const ompBinary = process.env.OMP_E2E_OMP_BINARY;
assert.ok(
  endpoint && workspacePath && ompBinary,
  "Set OMP_E2E_CDP_URL, OMP_E2E_WORKSPACE_PATH and OMP_E2E_OMP_BINARY for an isolated desktop instance",
);

function readCallableSkills() {
  return new Promise((resolve, reject) => {
    const child = spawn(ompBinary, ["--mode", "rpc-ui"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (error, names) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(names);
    };
    const timer = setTimeout(() => finish(new Error("omp skill catalog timed out")), 10_000);
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("omp exited before returning its command catalog")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id !== "gui-skills") continue;
        if (!frame.success) {
          finish(new Error(frame.error ?? "omp skill catalog failed"));
          return;
        }
        finish(
          null,
          frame.data.commands
            .filter((command) => command.source === "skill")
            .map((command) => command.name.slice("skill:".length))
            .sort(),
        );
        return;
      }
    });
    child.stdin.end(`${JSON.stringify({ id: "gui-skills", type: "get_available_commands" })}\n`);
  });
}

const expectedNames = await readCallableSkills();
assert.ok(expectedNames.length > 0, "The fixture profile must expose callable omp skills");
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => /^(file:|http:\/\/127\.0\.0\.1:)/u.test(candidate.url()));
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  if (await page.getByRole("button", { name: /^(Settings|设置)$/u }).count()) {
    await page.getByRole("button", { name: /^(Settings|设置)$/u }).click();
  }
  await page.getByRole("button", { name: /^(Skills|技能)$/u }).click();
  const scope = page.getByTestId("plugin-settings-scope-trigger");
  assert.notEqual(await scope.getAttribute("data-plugin-scope-key"), "user");
  assert.equal(
    await page.getByText(/Locally managed skills|本地可管理技能/u).count(),
    0,
    "Skills settings must not show ZCode-scanned skills",
  );
  const catalog = page.getByTestId("omp-available-skills");
  await catalog.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid="omp-available-skills"] [data-omp-skill-name]')
        .length === count,
    expectedNames.length,
    { timeout: 5000 },
  );
  assert.deepEqual(
    (
      await catalog
        .locator("[data-omp-skill-name]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-omp-skill-name")))
    ).sort(),
    expectedNames,
  );
  await scope.click();
  assert.equal(await page.getByTestId("plugin-settings-scope-user-option").count(), 0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^(Back to workspace|返回工作区)$/u })
    .first()
    .click();
  const composer = page.getByTestId("v4-composer-input");
  const skillName = expectedNames[0];
  const optionName = new RegExp(
    `^\\$?${skillName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} omp`,
    "u",
  );
  for (const prefix of ["$", "/"]) {
    await composer.click({ timeout: 5000 });
    await composer.press("ControlOrMeta+A");
    await composer.press("Backspace");
    await composer.fill(`${prefix}${skillName}`);
    await page.getByRole("option", { name: optionName }).waitFor({ timeout: 5000 });
  }
  console.log(
    `omp GUI skills: settings, $ and / match ${expectedNames.length} callable omp skills`,
  );
} finally {
  await browser.close();
}
