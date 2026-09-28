import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { applyOfflineLockState } from "../src/lib/offlineLockGate.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkspaceMobileRelayTrigger } from "../src/WorkspaceMobileRelayTrigger.js";

const platformStub = {} as IPlatformService;

function renderRelayTrigger() {
  return renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform: platformStub },
      createElement(
        TooltipProvider,
        null,
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(WorkspaceMobileRelayTrigger, { compact: true }),
        ),
      ),
    ),
  );
}

test("离线锁定下手机远控入口保留并呈禁用态；未锁定恢复可用", () => {
  try {
    // 入口必须始终渲染（mobile-relay.md：锁定期间入口保留，禁用态 + 说明）。
    applyOfflineLockState({ localOnly: true });
    const lockedHtml = renderRelayTrigger();
    assert.match(lockedHtml, /aria-disabled="true"/u);
    assert.match(lockedHtml, /opacity-50/u);
    assert.match(lockedHtml, /mobileRelayTrigger|手机远控/u);

    applyOfflineLockState({ localOnly: false });
    const unlockedHtml = renderRelayTrigger();
    assert.doesNotMatch(unlockedHtml, /aria-disabled="true"/u);
    // 基础按钮类含 disabled:opacity-50，未锁定的自定义 opacity-50 是独立 class token。
    assert.doesNotMatch(unlockedHtml, /[\s"']opacity-50[\s"']/u);
  } finally {
    applyOfflineLockState({ localOnly: false });
  }
});
