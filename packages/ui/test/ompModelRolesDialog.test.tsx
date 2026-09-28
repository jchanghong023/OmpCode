import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { OmpModelRolesDialog } from "../src/v4/composer/OmpModelRolesDialog.js";

test("无配置、无模型目录时模型设置仍展示所有内建角色", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
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
  );
  assert.match(html, /omp 尚未提供可选模型/u);
  for (const role of [
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
  ]) {
    assert.match(html, new RegExp(`aria-label="${role}"`, "u"));
  }
});
