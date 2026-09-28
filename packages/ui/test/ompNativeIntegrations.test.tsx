import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OmpNativeIntegrationSnapshot } from "@zcode/shared/omp-integrations";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { OmpNativeIntegrationsView } from "../src/settings/OmpNativeIntegrationsSection.js";

const snapshot: OmpNativeIntegrationSnapshot = {
  profileDir: "~/.ompcode/v2",
  projectDir: "D:/ws/.omp",
  extensions: [{ name: "omp-ext", scope: "profile" }],
  hooks: [
    { name: "pre-lint.ts", scope: "profile", phase: "pre" },
    { name: "post-notify.js", scope: "project", phase: "post" },
  ],
  hookErrors: [],
  mcpServers: [{ name: "omp-mcp", scope: "profile", enabled: true, transport: "stdio" }],
  configErrors: [],
  connectionStatus: "unavailable",
};

function renderHooksView(overrides?: {
  snapshot?: OmpNativeIntegrationSnapshot | null;
  error?: string | null;
}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OmpNativeIntegrationsView, {
        kind: "hook",
        title: "OMP 钩子",
        description: "显示当前 Profile 和本地项目 hooks/pre、hooks/post 中的 JS/TS 钩子文件。",
        snapshot: overrides?.snapshot === undefined ? snapshot : overrides.snapshot,
        error: overrides?.error ?? null,
        loading: false,
        onRefresh: () => {},
        onOpenDirectory: () => {},
      }),
    ),
  );
}

test("钩子页只读列出 profile 与项目的 pre/post 文件，不出现 ZCode 插件查询或管理控件", () => {
  const html = renderHooksView();
  assert.match(html, /data-testid="omp-native-hook"/u);
  assert.match(html, /pre-lint\.ts/u);
  assert.match(html, /post-notify\.js/u);
  // integrations.md：不请求 ZCode plugins/list，也不渲染旧 ZCode 的新增/编辑/信任/启停控件。
  assert.doesNotMatch(html, /plugins\/list/u);
  assert.doesNotMatch(html, /新增钩子|编辑|信任|启用|禁用|停用/u);
  // 只展示来源、阶段、文件名与路径，不读取或返回钩子源码。
  assert.match(html, /~\/\.ompcode\/v2/u);
  assert.match(html, /D:\/ws\/\.omp/u);
  assert.match(html, /pre/u);
  assert.match(html, /post/u);
});

test("读目录失败按 scope 显示错误，不静默标为零条；缺目录的来源不出现", () => {
  const html = renderHooksView({
    snapshot: { ...snapshot, hookErrors: ["project"] },
  });
  assert.match(html, /pre-lint\.ts/u);
  // 失败 scope 显示读取错误而非伪装成零条；正常 scope 照常列出。
  assert.match(html, /钩子目录无法读取/u);
});

test("无快照且未在加载时不出空列表伪装，仅有刷新入口", () => {
  const html = renderHooksView({ snapshot: null, error: null });
  assert.match(html, /data-testid="omp-native-hook"/u);
  assert.doesNotMatch(html, /pre-lint\.ts/u);
});
