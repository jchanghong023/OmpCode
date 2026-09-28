import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { OmpDesktopComposerStatus } from "../src/v4/composer/OmpDesktopComposerStatus.js";

test("桌面输入框状态栏不展示压缩上下文和自动压缩入口", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OmpDesktopComposerStatus, {
        scopeKey: "session-1",
        planModelActive: false,
        planModelAvailable: true,
        onTogglePlanModel: async () => ({ success: true }),
      }),
    ),
  );

  assert.match(html, /data-testid="omp-desktop-composer-status"/u);
  assert.match(html, /计划模型/u);
  assert.doesNotMatch(html, /压缩上下文|自动压缩/u);
});
