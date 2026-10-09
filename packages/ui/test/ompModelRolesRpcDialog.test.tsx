import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { build as Build } from "esbuild";
import type { _electron as Launcher, ElectronApplication } from "playwright-core";

test("真实 RPC 角色编辑器携带逐角色修订、采用保存后修订，冲突不覆盖新事实", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const desktopRequire = createRequire(join(repo, "packages/desktop/package.json"));
  const serverRequire = createRequire(join(repo, "packages/server/package.json"));
  const { build } = serverRequire("esbuild") as { build: typeof Build };
  const { _electron } = desktopRequire("playwright-core") as { _electron: typeof Launcher };
  const dir = await mkdtemp(join(tmpdir(), "omp-rpc-role-ui-"));
  let app: ElectronApplication | undefined;
  try {
    await build({
      stdin: {
        resolveDir: repo,
        loader: "tsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
          import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.tsx";
          import { OmpModelRolesDialog } from "./packages/ui/src/v4/composer/OmpModelRolesDialog.tsx";
          const roles = ["default", "task"].map(roleId=>({roleId,configurable:true,revision:roleId+"-1"}));
          window.roleCalls=[];
          window.roleFacts=roles;
          const service={
            getOmpModelRoles:async()=>({roles:roles.map(r=>({...r})),revision:"directory-is-not-a-role"}),
            setOmpModelRole:async(params)=>{
              window.roleCalls.push(params);
              const role=roles.find(r=>r.roleId===params.roleId);
              if(params.expectedRevision!==role.revision)throw new Error("revision_conflict");
              role.revision=role.roleId+"-"+(Number(role.revision.split("-").at(-1))+1);
              role.explicitValue=params.selection.model.provider+"/"+params.selection.model.modelId+":"+params.selection.model.thinkingLevel;
              return {persisted:true,role:{...role}};
            }
          };
          window.roleResolution={services:{zcodeAgentService:service},rpcReady:true,isRemoteTarget:false};
          const platform={listOmpProfiles:async()=>({success:true,activeProfile:"",profiles:[]})};
          const catalog=[{providerId:"provider",providerName:"Provider",modelId:"model",modelName:"Model",thoughtLevels:["low","high"],defaultThoughtLevel:"low"}];
          createRoot(document.getElementById("root")).render(<ZCodeIntlProvider initialLocale="zh-CN"><PlatformProvider platform={platform}><OmpModelRolesDialog inline catalogEntries={catalog} workspacePath="isolated-workspace" /></PlatformProvider></ZCodeIntlProvider>);
        `,
      },
      plugins: [
        {
          name: "service-boundary",
          setup(plugin) {
            plugin.onResolve(
              { filter: /^@\/hooks\/(useWorkspaceServices|useSettingService)\.js$/ },
              (args) => ({ path: args.path, namespace: "role-test" }),
            );
            plugin.onLoad({ filter: /.*/, namespace: "role-test" }, (args) => ({
              contents: args.path.includes("useWorkspaceServices")
                ? "export const useWorkspaceServicesResolution=()=>window.roleResolution"
                : "export const useSettings=()=>({settings:{ompProfile:''}})",
              loader: "js",
            }));
          },
        },
      ],
      bundle: true,
      platform: "browser",
      format: "iife",
      tsconfig: join(repo, "packages/ui/tsconfig.json"),
      outfile: join(dir, "renderer.js"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><div id="root"></div><script src="renderer.js"></script>',
    );
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "data"))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(dir, "index.html"))})});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: desktopRequire("electron"),
      args: [join(dir, "main.cjs")],
      env,
    });
    const page = await app.firstWindow();
    const choose = async (label: string, option: string) => {
      await page.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    const calls = async () =>
      page.evaluate(
        () =>
          (window as unknown as { roleCalls: Array<{ roleId: string; expectedRevision?: string }> })
            .roleCalls,
      );
    await choose("default", "Model");
    await page.waitForFunction(
      () =>
        (window as unknown as { roleFacts: Array<{ revision: string }> }).roleFacts[0]?.revision ===
        "default-2",
    );
    await choose("default 思考等级", "high");
    await page.waitForFunction(
      () =>
        (window as unknown as { roleFacts: Array<{ revision: string }> }).roleFacts[0]?.revision ===
        "default-3",
    );
    await choose("task", "Model");
    await page.waitForFunction(
      () =>
        (window as unknown as { roleFacts: Array<{ revision: string }> }).roleFacts[1]?.revision ===
        "task-2",
    );
    assert.deepEqual(
      (await calls()).map((call) => [call.roleId, call.expectedRevision]),
      [
        ["default", "default-1"],
        ["default", "default-2"],
        ["task", "task-1"],
      ],
    );
    await page.evaluate(() => {
      const roles = (
        window as unknown as { roleFacts: Array<{ revision: string; explicitValue: string }> }
      ).roleFacts;
      roles[1].revision = "task-3";
      roles[1].explicitValue = "outside/external:high";
    });
    await choose("task 思考等级", "high");
    await page.getByText("保存失败: revision_conflict", { exact: true }).waitFor();
    assert.equal((await calls()).at(-1)?.expectedRevision, "task-2");
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { roleFacts: Array<{ explicitValue: string }> }).roleFacts[1]
            .explicitValue,
      ),
      "outside/external:high",
    );
    assert.equal(
      await page.getByRole("combobox", { name: "task 思考等级", exact: true }).textContent(),
      "high",
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
