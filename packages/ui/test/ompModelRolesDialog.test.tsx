import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { OmpModelRolesDialog } from "../src/v4/composer/OmpModelRolesDialog.js";
import { OmpModelRolesFallbackFields } from "../src/v4/composer/OmpModelRolesFallbackFields.js";

/** 最小服务访问器：RPC 目录查询按能力缺失拒绝（-32601 文案），对话框应回落本地配置分支。 */
const stubAccessor = {
  zcodeAgentService: {
    getOmpModelRoles: async () => {
      throw new Error("method not supported by omp core: workspace/ompModelRoles");
    },
  },
} as unknown as IServiceAccessor;

const BUILTIN_ROLES = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "memory",
  "task",
  "advisor",
  "image",
  "web",
  "speech",
  "dictation",
  "judge",
];

test("回落分支：无配置、无模型目录时仍展示所有内建角色", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: {} as IPlatformService },
        createElement(OmpModelRolesFallbackFields, { catalogEntries: [], inline: true }),
      ),
    ),
  );
  assert.match(html, /omp 尚未提供可选模型/u);
  for (const role of BUILTIN_ROLES) {
    assert.match(html, new RegExp(`aria-label="${role}"`, "u"));
  }
});

test("对话框：RPC 目录不可用时完整渲染且不崩（SSR 初始 loading 态渲染壳层）", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TabStoreProvider,
        null,
        createElement(
          ServiceProvider,
          { services: stubAccessor },
          createElement(
            PlatformProvider,
            { platform: {} as IPlatformService },
            createElement(OmpModelRolesDialog, {
              inline: true,
              catalogEntries: [],
              workspacePath: "",
            }),
          ),
        ),
      ),
    ),
  );
  // inline 模式渲染设置区块（source=loading 的字段区为空，由上一用例覆盖回落分支内容）。
  assert.match(html, /omp-model-roles-section/u);
  assert.match(html, /模型设置/u);
});
