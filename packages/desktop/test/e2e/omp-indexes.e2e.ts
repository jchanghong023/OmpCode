import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE,
  setCurrentElectronRendererContentSize,
  setInputValueByTestIdDom,
} from "./helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "./helpers/v4-conversation.js";
import { setPluginPresentation } from "./helpers/plugin-management-lifecycle.js";

const runFile = promisify(execFile);
const tid = (id: string) => $(`[data-testid="${id}"]`);
const directory = resolve(DEFAULT_WORKSPACE, "omp-indexes-manuals");
const documentPath = resolve(directory, "NativeIndexBeacon.md");
const spacedDocumentPath = resolve(directory, "SpacedExpression.md");
const unspacedDocumentPath = resolve(directory, "UnspacedExpression.md");
const sourcePath = resolve(DEFAULT_WORKSPACE, "omp-index-beacon.ts");
const symbolSourcePath = resolve(DEFAULT_WORKSPACE, "omp-index-symbol-beacon.py");
const body =
  "# NativeIndexBeacon\n\nNativeIndexBeacon stores the complete offline manual.\n\nThe final paragraph must remain visible: OMP_INDEX_FULL_BODY_END.\n";
const source =
  "export function nativeIndexBeacon(value: string): string {\n  return `OMP_INDEX_SOURCE_BEACON:${value}`;\n}\n";
const symbolSource =
  "def native_index_beacon(value: str) -> str:\n    return f'OMP_INDEX_SYMBOL_BEACON:{value}'\n";
async function click(id: string) {
  const element = tid(id);
  await element.waitForDisplayed({ timeout: 30000 });
  await element.scrollIntoView({ block: "center" });
  await element.waitForClickable({ timeout: 30000 });
  await element.click();
}
async function enterInput(id: string, value: string) {
  const element = tid(id);
  await element.waitForDisplayed();
  // 新布局中的检索区位于管理区下方；先滚动真实输入框，避免 WebDriver clear 操作离屏节点。
  await element.scrollIntoView({ block: "center" });
  await element.waitForEnabled();
  await element.setValue(value);
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

async function captureIndexPresentation(page: "wiki" | "repo", label: string) {
  const original = await browser.execute(() => {
    const actions = (
      window as typeof window & {
        __testActions?: {
          getTheme: () => "light" | "dark" | "zai-light" | "zai-dark" | "system";
          getLocale: () => "zh-CN" | "en-US";
        };
      }
    ).__testActions;
    if (!actions) throw new Error("Presentation test actions are required");
    return {
      theme: actions.getTheme(),
      locale: actions.getLocale(),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  // 此 fixture 只切换表现，不注入索引或结果；业务通过依据仍是原生数据库操作与结果断言。
  try {
    for (const presentation of [
      { name: "zai-light", width: original.width, height: original.height },
      { name: "zai-light-narrow", width: 900, height: 720 },
    ]) {
      await setPluginPresentation({
        locale: original.locale,
        theme: "zai-light",
        width: presentation.width,
        height: presentation.height,
      });
      const layout = await browser.execute((currentPage) => {
        const root = document.querySelector<HTMLElement>(`[data-testid="omp-${currentPage}-page"]`);
        if (!root) throw new Error(`Missing index page: ${currentPage}`);
        return {
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
        };
      }, page);
      expect(layout.clientWidth).toBeGreaterThan(0);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);
      await browser.saveScreenshot(
        resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${label}-${presentation.name}.png`),
      );
    }
  } finally {
    await browser.executeAsync((previous, done: () => void) => {
      const actions = (
        window as typeof window & {
          __testActions?: { setTheme: (theme: typeof previous.theme) => void };
        }
      ).__testActions;
      if (!actions) throw new Error("Presentation test actions are required");
      actions.setTheme(previous.theme);
      requestAnimationFrame(() => done());
    }, original);
    await setCurrentElectronRendererContentSize(original.width, original.height);
  }
}

describe("OMP native Wiki / Repo dedicated GUI", () => {
  it("builds, queries, refreshes and removes real profile indexes without any model call", async function () {
    this.timeout(360000);
    if (!process.env.PI_CODING_AGENT_DIR || !process.env.ZCODE_E2E_ARTIFACT_DIR)
      throw new Error("Isolated OMP profile and artifact directory are required");
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(directory, { recursive: true });
    await writeFile(documentPath, body);
    await writeFile(spacedDocumentPath, "# SpacedExpression\n\n OMP_GREP_SPACE_BEACON \n");
    await writeFile(unspacedDocumentPath, "# UnspacedExpression\n\nOMP_GREP_SPACE_BEACON\n");
    await writeFile(sourcePath, source);
    // 原生 Repo 只为 .py 提取符号；TS 仍独立验证全文检索与更新，不能拿空符号表验收函数。
    await writeFile(symbolSourcePath, symbolSource);
    // 测试只初始化隔离工作区；原生 Repo root 由真实 Git 解析，不能伪造 status。
    await runFile("git", ["init", DEFAULT_WORKSPACE]);
    const ledgerBefore = (await modelLedger()).length;
    await click("omp-wiki-sidebar-open");
    await idle("omp-wiki-refresh");
    await enterInput("omp-wiki-directory", directory);
    await enterInput("omp-wiki-name", "omp-indexes-e2e");
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
    await enterInput("omp-wiki-query", "  NativeIndexBeacon  ");
    await click("omp-wiki-search");
    await browser.waitUntil(
      async () => (await tid("omp-wiki-results").getText()).includes("OMP_INDEX_FULL_BODY_END"),
      { timeout: 30000 },
    );
    expect(await tid("omp-wiki-results").getText()).toContain("NativeIndexBeacon.md");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-wiki-full-body.png"),
    );
    await captureIndexPresentation("wiki", "omp-wiki-full-body");

    await idle("omp-wiki-refresh");
    await $('select:has(option[value="grep"])').selectByAttribute("value", "grep");
    // 清空受控输入必须派发 input/change；仅 WebDriver clear 可能留下旧 React query。
    await setInputValueByTestIdDom("omp-wiki-query", "");
    expect(await tid("omp-wiki-query").getValue()).toBe("");
    await tid("omp-wiki-search").waitForEnabled({ reverse: true });
    expect(await tid("omp-wiki-search").isEnabled()).toBe(false);
    // 首尾空格属于原生正则：裁剪后会误命中无空格文档，必须比较真实数据库结果。
    for (const expression of [
      " OMP_GREP_SPACE_BEACON ",
      " OMP_GREP_SPACE_BEACON",
      "OMP_GREP_SPACE_BEACON ",
    ]) {
      await enterInput("omp-wiki-query", expression);
      expect(await tid("omp-wiki-query").getValue()).toBe(expression);
      await click("omp-wiki-search");
      await idle("omp-wiki-refresh");
      const matches = await tid("omp-wiki-results").getText();
      expect(matches).toContain("SpacedExpression.md");
      expect(matches).not.toContain("UnspacedExpression.md");
      expect(matches).not.toContain("NativeIndexBeacon.md");
    }
    await enterInput("omp-wiki-query", "OMP_GREP_SPACE_BEACON");
    await click("omp-wiki-search");
    await idle("omp-wiki-refresh");
    expect(await tid("omp-wiki-results").getText()).toContain("SpacedExpression.md");
    expect(await tid("omp-wiki-results").getText()).toContain("UnspacedExpression.md");
    // 原生 grep 拒绝纯空白 query；保留原串提交并展示真实错误，不能误判为合法正则。
    await enterInput("omp-wiki-query", " ");
    expect(await tid("omp-wiki-query").getValue()).toBe(" ");
    await tid("omp-wiki-search").waitForEnabled();
    expect(await tid("omp-wiki-search").isEnabled()).toBe(true);
    await click("omp-wiki-search");
    const wikiError = await tid("omp-wiki-page").$('[role="alert"]');
    await wikiError.waitForDisplayed();
    await browser.waitUntil(
      async () => (await wikiError.getText()).includes("Missing documentation grep query"),
      { timeout: 30000 },
    );
    // 用合法字符类匹配空格，确认错误后仍可查询并命中真实原始手册。
    await enterInput("omp-wiki-query", "[ ]");
    expect(await tid("omp-wiki-query").getValue()).toBe("[ ]");
    await click("omp-wiki-search");
    await browser.waitUntil(
      async () => (await tid("omp-wiki-results").getText()).includes("NativeIndexBeacon.md"),
      { timeout: 30000 },
    );

    await click("omp-repo-sidebar-open");
    await idle("omp-repo-refresh");
    await confirmRepo("init");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("true");
    const generation = await tid("omp-repo-status").getAttribute("data-generation");
    expect(generation).toBeTruthy();
    await enterInput("omp-repo-query", "OMP_INDEX_SOURCE_BEACON");
    await enterInput("omp-repo-path", "omp-index-beacon.ts");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("OMP_INDEX_SOURCE_BEACON"),
      { timeout: 30000 },
    );
    await tid("omp-repo-mode").selectByAttribute("value", "symbol");
    await enterInput("omp-repo-query", "native_index_beacon");
    await enterInput("omp-repo-path", "omp-index-symbol-beacon.py");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("native_index_beacon"),
      { timeout: 30000 },
    );
    const symbolHit = await tid("omp-repo-results").$("article");
    expect(await symbolHit.$("h3").getText()).toBe("native_index_beacon");
    expect(await symbolHit.getText()).toContain("function");
    const symbolLocation = (await symbolHit.getText()).match(
      /omp-index-symbol-beacon\.py:(\d+)–(\d+)/,
    );
    expect(symbolLocation).not.toBeNull();
    expect(Number(symbolLocation![1])).toBe(1);
    expect(Number(symbolLocation![2])).toBeGreaterThanOrEqual(Number(symbolLocation![1]));
    expect(Number(symbolLocation![2])).toBeLessThanOrEqual(
      symbolSource.trimEnd().split("\n").length,
    );
    await writeFile(
      sourcePath,
      `${source}\nexport const updatedIndexBeacon = "OMP_INDEX_UPDATED_BEACON";\n`,
    );
    await confirmRepo("update");
    await tid("omp-repo-mode").selectByAttribute("value", "text");
    await enterInput("omp-repo-path", "omp-index-beacon.ts");
    await enterInput("omp-repo-query", "OMP_INDEX_UPDATED_BEACON");
    await click("omp-repo-search");
    await browser.waitUntil(
      async () => (await tid("omp-repo-results").getText()).includes("OMP_INDEX_UPDATED_BEACON"),
      { timeout: 30000 },
    );
    await confirmRepo("rebuild");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-repo-rebuilt.png"),
    );
    await captureIndexPresentation("repo", "omp-repo-rebuilt");
    await browser.refresh();
    await click("omp-repo-sidebar-open");
    await idle("omp-repo-refresh");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("true");
    await confirmRepo("remove");
    expect(await tid("omp-repo-status").getAttribute("data-exists")).toBe("false");
    expect(await readFile(sourcePath, "utf8")).toContain("OMP_INDEX_UPDATED_BEACON");
    expect(await readFile(symbolSourcePath, "utf8")).toBe(symbolSource);

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
    const ledgerAfter = await modelLedger();
    if (ledgerAfter.length !== ledgerBefore) {
      // 失败后 fixture 会关闭内存账本；先保全真实请求正文，不能把初始化请求猜成索引调用或重置基线。
      await writeFile(
        resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-indexes-model-requests.failure.json"),
        JSON.stringify({ baselineCount: ledgerBefore, requests: ledgerAfter }, null, 2),
      );
    }
    expect(ledgerAfter.length).toBe(ledgerBefore);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR, "omp-indexes-evidence.json"),
      JSON.stringify(
        {
          directory,
          documentPath,
          sourcePath,
          symbolSourcePath,
          symbolLocation: symbolLocation![0],
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
