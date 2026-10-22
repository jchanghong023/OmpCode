import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "./helpers/v4-conversation.js";

const runFile = promisify(execFile);
const tid = (id: string) => $(`[data-testid="${id}"]`);
const directory = resolve(DEFAULT_WORKSPACE, "omp-indexes-manuals");
const documentPath = resolve(directory, "NativeIndexBeacon.md");
const sourcePath = resolve(DEFAULT_WORKSPACE, "omp-index-beacon.ts");
const body =
  "# NativeIndexBeacon\n\nNativeIndexBeacon stores the complete offline manual.\n\nThe final paragraph must remain visible: OMP_INDEX_FULL_BODY_END.\n";
const source =
  "export function nativeIndexBeacon(value: string): string {\n  return `OMP_INDEX_SOURCE_BEACON:${value}`;\n}\n";
async function click(id: string) {
  const element = tid(id);
  await element.waitForDisplayed({ timeout: 30000 });
  await element.scrollIntoView({ block: "center" });
  await element.waitForClickable({ timeout: 30000 });
  await element.click();
}
async function idle(id: string) {
  await browser.waitUntil(async () => await tid(id).isEnabled(), {
    timeout: 120000,
    timeoutMsg: `Native index operation did not finish: ${id}`,
  });
}
async function modelLedger() {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated native OMP fixture required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Fixture ledger failed: ${response.status}`);
  return (await response.json()) as unknown[];
}
async function confirmRepo(action: "init" | "update" | "rebuild" | "remove") {
  const rootText = await tid("omp-repo-root").getText();
  await click(`omp-repo-${action}`);
  const confirmed = await tid("omp-repo-confirm-root").getText();
  expect(rootText).toContain(confirmed);
  expect(confirmed.length).toBeGreaterThan(1);
  await click("omp-index-confirm");
  await idle("omp-repo-refresh");
}

describe("OMP native Wiki / Repo dedicated GUI", () => {
  it("builds, queries, refreshes and removes real profile indexes without any model call", async function () {
    this.timeout(360000);
    if (!process.env.PI_CODING_AGENT_DIR || !process.env.ZCODE_E2E_ARTIFACT_DIR)
      throw new Error("Isolated OMP profile and artifact directory are required");
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(directory, { recursive: true });
    await writeFile(documentPath, body);
    await writeFile(sourcePath, source);
    // 测试只初始化隔离工作区；原生 Repo root 由真实 Git 解析，不能伪造 status。
    await runFile("git", ["init", DEFAULT_WORKSPACE]);
    const ledgerBefore = (await modelLedger()).length;
    await click("omp-wiki-sidebar-open");
    await idle("omp-wiki-refresh");
    await tid("omp-wiki-directory").setValue(directory);
    await tid("omp-wiki-name").setValue("omp-indexes-e2e");
    await click("omp-wiki-init");
    expect(await tid("omp-wiki-confirm-directory").getText()).toBe(directory);
    await click("omp-index-confirm");
    await browser.waitUntil(
      async () => (await tid("omp-wiki-indexes").getText()).includes("omp-indexes-e2e"),
      { timeout: 120000 },
    );
    expect((await stat(resolve(process.env.PI_CODING_AGENT_DIR, "docs.db"))).size).toBeGreaterThan(
      0,
    );
    await tid("omp-wiki-query").setValue("NativeIndexBeacon");
    await click("omp-wiki-search");
    await browser.waitUntil(
      async () => (await tid("omp-wiki-results").getText()).includes("OMP_INDEX_FULL_BODY_END"),
      { timeout: 30000 },
    );
    expect(await tid("omp-wiki-results").getText()).toContain("NativeIndexBeacon.md");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-wiki-full-body.png"),
    );

    await click("omp-repo-sidebar-open");
    await idle("omp-repo-refresh");
    await confirmRepo("init");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("true");
    const generation = await tid("omp-repo-status").getAttribute("data-generation");
    expect(generation).toBeTruthy();
    await tid("omp-repo-query").setValue("OMP_INDEX_SOURCE_BEACON");
    await tid("omp-repo-path").setValue("omp-index-beacon.ts");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("OMP_INDEX_SOURCE_BEACON"),
      { timeout: 30000 },
    );
    await tid("omp-repo-mode").selectByAttribute("value", "symbol");
    await tid("omp-repo-query").setValue("nativeIndexBeacon");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("nativeIndexBeacon"),
      { timeout: 30000 },
    );
    await writeFile(
      sourcePath,
      `${source}\nexport const updatedIndexBeacon = "OMP_INDEX_UPDATED_BEACON";\n`,
    );
    await confirmRepo("update");
    await tid("omp-repo-mode").selectByAttribute("value", "text");
    await tid("omp-repo-query").setValue("OMP_INDEX_UPDATED_BEACON");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("OMP_INDEX_UPDATED_BEACON"),
      { timeout: 30000 },
    );
    await confirmRepo("rebuild");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-repo-rebuilt.png"),
    );
    await browser.refresh();
    await click("omp-repo-sidebar-open");
    await idle("omp-repo-refresh");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("true");
    await confirmRepo("remove");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("false");
    expect(await readFile(sourcePath, "utf8")).toContain("OMP_INDEX_UPDATED_BEACON");

    await click("omp-wiki-sidebar-open");
    await idle("omp-wiki-refresh");
    const remove = $('[data-index-name="omp-indexes-e2e"] button');
    await remove.waitForClickable({ timeout: 30000 });
    await remove.click();
    await click("omp-index-confirm");
    await browser.waitUntil(
      async () => !(await $('[data-index-name="omp-indexes-e2e"]').isExisting()),
      { timeout: 30000 },
    );
    expect(await readFile(documentPath, "utf8")).toBe(body);
    expect((await modelLedger()).length).toBe(ledgerBefore);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-indexes-evidence.json"),
      JSON.stringify(
        {
          directory,
          documentPath,
          sourcePath,
          generation,
          wikiBodyMatched: true,
          repoTextAndSymbolMatched: true,
          sourcePreserved: true,
          modelRequests: 0,
        },
        null,
        2,
      ),
    );
  });
});
