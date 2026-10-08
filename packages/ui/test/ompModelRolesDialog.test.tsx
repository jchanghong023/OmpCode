import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { build as Build } from "esbuild";
import type { _electron as ElectronLauncher, ElectronApplication } from "playwright-core";
import { readOmpModelRolesConfig } from "../../desktop/src/main/ompModelRolesConfig.js";

declare global {
  interface Window {
    renderRoles: (inline: boolean, emptyCatalog?: boolean) => void;
  }
}

// 真实 Select/React 消费者通过 IPC 调用实际 YAML owner；所有配置与 Electron 数据都在 temp。
// 不再用 SSR 的 loading 壳或翻译措辞充当保存回归。
test("旧核设置与工具栏共享字段：auto/unset 持久化、未知值可见、失败保持 dirty", async () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const desktopRequire = createRequire(join(repoRoot, "packages/desktop/package.json"));
  const serverRequire = createRequire(join(repoRoot, "packages/server/package.json"));
  // Node 按已有 desktop/server 依赖解析工具，不为 UI 增加生产依赖。
  const { build } = serverRequire("esbuild") as { build: typeof Build };
  const { _electron } = desktopRequire("playwright-core") as { _electron: typeof ElectronLauncher };
  const dir = await mkdtemp(join(tmpdir(), "omp-role-ui-"));
  const configPath = join(dir, "config.yml");
  const original = [
    "# account",
    "modelRoles:",
    "  default: provider/model:high # role note",
    "  task: outside/catalog:custom # untouched role",
    "other: true # untouched setting",
    "",
  ].join("\n");
  let app: ElectronApplication | undefined;
  try {
    await writeFile(configPath, original);
    await build({
      stdin: {
        resolveDir: repoRoot,
        loader: "tsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { flushSync } from "react-dom";
          import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
          import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.tsx";
          import { OmpModelRolesFallbackFields } from "./packages/ui/src/v4/composer/OmpModelRolesFallbackFields.tsx";
          const { ipcRenderer } = window.require("electron");
          const platform = {
            readOmpModelRoles: () => ipcRenderer.invoke("roles:read"),
            writeOmpModelRoles: (updates) => ipcRenderer.invoke("roles:write", updates),
          };
          const catalog = [{providerId:"provider",providerName:"Provider",modelId:"model",modelName:"Model",thoughtLevels:["low","high"],defaultThoughtLevel:"high"}];
          const root = createRoot(document.getElementById("root"));
          let generation = 0;
          window.renderRoles = (inline, emptyCatalog = false) => flushSync(() => root.render(
            <ZCodeIntlProvider initialLocale="zh-CN"><PlatformProvider platform={platform}>
              <OmpModelRolesFallbackFields key={++generation} inline={inline} catalogEntries={emptyCatalog ? [] : catalog} />
            </PlatformProvider></ZCodeIntlProvider>
          ));
        `,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome120",
      tsconfig: join(repoRoot, "packages/ui/tsconfig.json"),
      outfile: join(dir, "renderer.js"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><body><div id="root"></div><script src="renderer.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: repoRoot,
        loader: "ts",
        contents: `
          import { app, BrowserWindow, ipcMain } from "electron";
          import { readOmpModelRolesConfig, writeOmpModelRolesConfig } from "./packages/desktop/src/main/ompModelRolesConfig.ts";
          app.setPath("userData", ${JSON.stringify(join(dir, "user-data"))});
          ipcMain.handle("roles:read", () => readOmpModelRolesConfig(${JSON.stringify(configPath)}));
          ipcMain.handle("roles:write", (_, updates) => writeOmpModelRolesConfig(${JSON.stringify(configPath)}, updates));
          app.whenReady().then(() => {
            const win = new BrowserWindow({show:false, webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
            win.loadFile(${JSON.stringify(join(dir, "index.html"))});
          });
          app.on("window-all-closed", () => app.quit());
        `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: join(dir, "main.cjs"),
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: desktopRequire("electron"),
      args: [join(dir, "main.cjs")],
      env,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.renderRoles === "function");
    const save = page.getByRole("button", { name: "保存", exact: true });
    const role = page.getByRole("combobox", { name: "default", exact: true });
    const choose = async (label: string) => {
      await role.click();
      // 菜单项是实际 Radix Select，点击产生真实 draft 变化。
      const option = page.getByRole("option", { name: label, exact: true });
      await option.waitFor({ state: "visible" });
      await option.click();
    };
    const render = async (inline: boolean, emptyCatalog = false) => {
      await page.evaluate(({ inline, emptyCatalog }) => window.renderRoles(inline, emptyCatalog), {
        inline,
        emptyCatalog,
      });
      await page.waitForFunction(() =>
        document
          .querySelector('[aria-label="task"]')
          ?.textContent?.includes("outside/catalog:custom"),
      );
    };
    for (const inline of [true, false]) {
      await writeFile(configPath, original);
      await render(inline);
      assert.equal(await save.isDisabled(), true);
      await role.click();
      assert.equal(await page.getByRole("option", { name: "自动", exact: true }).count(), 1);
      assert.equal(await page.getByRole("option", { name: "未配置", exact: true }).count(), 1);
      await page.keyboard.press("Escape");
      await choose("自动");
      assert.equal(await role.textContent(), "自动");
      assert.equal(
        await page.getByRole("combobox", { name: "default 思考等级", exact: true }).count(),
        0,
      );
      assert.equal(await save.isDisabled(), false);
      await save.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "保存" && button.disabled,
        ),
      );
      assert.deepEqual(await readOmpModelRolesConfig(configPath), {
        success: true,
        roles: [
          { role: "default", value: "auto" },
          { role: "task", value: "outside/catalog:custom" },
        ],
      });
      await render(inline);
      assert.equal(await role.textContent(), "自动");
      await choose("未配置");
      assert.equal(await save.isDisabled(), false);
      await save.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "保存" && button.disabled,
        ),
      );
      assert.deepEqual(await readOmpModelRolesConfig(configPath), {
        success: true,
        roles: [{ role: "task", value: "outside/catalog:custom" }],
      });
      assert.equal(
        await readFile(configPath, "utf8"),
        original.replace("  default: provider/model:high # role note\n", "  # role note\n"),
      );
      await render(inline);
      assert.equal(await role.textContent(), "未配置");
      assert.equal(await save.isDisabled(), true);

      // 真正写入边界失败：读取成功后外部把 temp YAML 改坏，不伪造平台返回值。
      await choose("自动");
      const cleared = await readFile(configPath, "utf8");
      await writeFile(configPath, "modelRoles: [\n");
      await save.click();
      await page.getByText("omp_config_parse_failed", { exact: true }).waitFor();
      assert.equal(await save.isDisabled(), false);
      assert.equal(await role.textContent(), "自动");
      assert.equal(await readFile(configPath, "utf8"), "modelRoles: [\n");
      await writeFile(configPath, cleared);
      await save.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "保存" && button.disabled,
        ),
      );
      assert.deepEqual(await readOmpModelRolesConfig(configPath), {
        success: true,
        roles: [
          { role: "task", value: "outside/catalog:custom" },
          { role: "default", value: "auto" },
        ],
      });
    }
    // 没有目录仍能选择 auto/unset，未知持久值也不是隐藏的未配置占位。
    await render(true, true);
    await role.click();
    assert.equal(await page.getByRole("option", { name: "自动", exact: true }).count(), 1);
    assert.equal(await page.getByRole("option", { name: "未配置", exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    const unknown = page.getByRole("combobox", { name: "task", exact: true });
    assert.equal(await unknown.textContent(), "outside/catalog:custom");
    await unknown.click();
    assert.equal(
      await page.getByRole("option", { name: "outside/catalog:custom", exact: true }).count(),
      1,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      (await readdir(dir)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
