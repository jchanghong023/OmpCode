// 真实公开 @ 文件入口；Host扫描次数由文件服务真实IO E2E独立计量。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createProjectTask } from "./ompPerformanceHotPaths.guiChecks.mjs";

const manifestPath = process.env.OMP_E2E_RUNTIME_MANIFEST;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const marker = process.env.OMP_E2E_RUN_ID;
assert.ok(manifestPath && evidenceDir && marker);
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(runtime.endpoint && runtime.rendererUrl && runtime.runRoot);
const workspacePath =
  runtime.requestedWorkspace ?? join(runtime.runRoot, "data/.ompcode/workspace/default");
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.connectOverCDP(runtime.endpoint);
const page = browser
  .contexts()[0]
  ?.pages()
  .find((candidate) => candidate.url().startsWith(runtime.rendererUrl));
assert.ok(page);
page.setDefaultTimeout(30_000);
const input = page.getByTestId("v4-composer-input").first();
const evidence = [];
const filename = `hotpaths-new-${marker}.txt`;
try {
  // 全局入口创建无项目草稿，检索目标与文件写入目录会错位；复用沙箱项目的真实建任务入口。
  await createProjectTask(page, workspacePath);
  await input.waitFor({ state: "visible" });
  await page.evaluate(() => {
    const original = MessagePort.prototype.postMessage;
    window.mentionTelemetry = {
      searches: 0,
      refreshes: 0,
      restore: () => {
        MessagePort.prototype.postMessage = original;
      },
    };
    MessagePort.prototype.postMessage = function (...args) {
      const value = args[0];
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
      const text = bytes
        ? new TextDecoder().decode(bytes)
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
      if (text?.includes("searchWorkspaceFiles")) {
        window.mentionTelemetry.searches++;
        if (/"refresh"\s*:\s*true/u.test(text)) window.mentionTelemetry.refreshes++;
      }
      return Reflect.apply(original, this, args);
    };
  });
  await input.fill("");
  await input.pressSequentially(`@zzzz-no-such-${marker}`, { delay: 40 });
  await page.getByTestId("prompt-suggestion-panel").waitFor({ state: "visible" });
  await page.waitForTimeout(450);
  const counts = await page.evaluate(() => ({
    searches: window.mentionTelemetry.searches,
    refreshes: window.mentionTelemetry.refreshes,
  }));
  assert.ok(counts.searches > 1, "Exercise different live file prefixes through the actual editor");
  assert.ok(
    counts.refreshes <= 1,
    "Distinct misses within one open panel must reuse its refresh round",
  );
  evidence.push({ event: "consecutive-live-misses", ...counts, scanBoundary: "service-IO-E2E" });
  await page.screenshot({
    path: join(evidenceDir, "mentions-no-matches.png"),
    animations: "disabled",
  });
  await writeFile(join(workspacePath, filename), `${marker} temporary test fixture\n`);
  // 真实输入清空后立即开始下一查询，空query不等待一次慢文件请求。
  await input.fill("");
  await input.pressSequentially(`@${filename}`, { delay: 0 });
  const option = page
    .locator('[data-testid^="prompt-suggestion-option-"]')
    .filter({ hasText: filename })
    .first();
  await option.waitFor({ state: "visible" });
  await option.click();
  assert.ok(
    (await input.innerText()).includes(filename),
    "New file is insertable through the actual mention candidate",
  );
  evidence.push({
    event: "new-file-fast-clear-next-query",
    filename,
    selected: true,
    rawEmptyConsumedByUI: true,
    deferredSkipBoundary: "separate-real-hook-probe",
  });
  await page.screenshot({
    path: join(evidenceDir, "mentions-new-file-selected.png"),
    animations: "disabled",
  });
  await page.waitForTimeout(450);
  const markdown = await input.evaluate((element) => element.__zcodeLexicalInputE2E.getText());
  assert.equal(await input.locator("[data-mention-id]").count(), 1);
  await input.press("Control+A");
  await input.press("Control+C");
  await input.press("Control+V");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.querySelectorAll("[data-mention-id]").length === 0,
  );
  assert.equal(
    await input.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    markdown,
    "Rich-node replacement keeps the same canonical Markdown",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.reload();
  await input.waitFor({ state: "visible" });
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === expected,
    markdown,
  );
  assert.equal(
    await input.locator("[data-mention-id]").count(),
    0,
    "Flush must not revive the old mention node after a same-Markdown paste",
  );
  evidence.push({
    event: "same-markdown-rich-json-recovery",
    actualClipboardPaste: true,
    richNodeCountAfterReload: 0,
    markdownUnchanged: true,
    blurBoundary: "lifecycle-listener",
  });
  await page.screenshot({
    path: join(evidenceDir, "mentions-same-markdown-restored.png"),
    animations: "disabled",
  });
  await writeFile(
    join(evidenceDir, "mentions-hotpaths-result.json"),
    JSON.stringify({ kind: "real-desktop-file-mention-E2E", workspacePath, evidence }, null, 2),
  );
  console.log(`PASS real file mention GUI: ${evidenceDir}`);
} catch (error) {
  await page
    .screenshot({ path: join(evidenceDir, "mentions-failure.png"), animations: "disabled" })
    .catch(() => {});
  await writeFile(
    join(evidenceDir, "mentions-hotpaths-failure.json"),
    JSON.stringify({ message: error.message, evidence }, null, 2),
  );
  throw error;
} finally {
  await page.evaluate(() => window.mentionTelemetry?.restore()).catch(() => {});
  await browser.close();
}
