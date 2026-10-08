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

function renderView(overrides?: {
  kind?: "extension" | "mcp" | "hook";
  snapshot?: OmpNativeIntegrationSnapshot | null;
  error?: string | null;
}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OmpNativeIntegrationsView, {
        kind: overrides?.kind ?? "hook",
        title: overrides?.kind === "mcp" ? "OMP MCP 服务器" : "OMP 钩子",
        description: "显示当前 Profile 和本地项目中的原生配置。",
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
  const html = renderView();
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

test("读目录部分失败仍列出同 scope 已发现钩子，不静默标为零条", () => {
  const html = renderView({
    snapshot: { ...snapshot, hookErrors: ["project"] },
  });
  assert.match(html, /pre-lint\.ts/u);
  assert.match(html, /post-notify\.js/u);
  // 失败 scope 的有效文件与读取错误同时显示，不冒充零条。
  assert.match(html, /钩子目录无法读取/u);
  assert.doesNotMatch(html, /未发现配置项/u);
});

test("无快照且未在加载时不出空列表伪装，仅有刷新入口", () => {
  const html = renderView({ snapshot: null, error: null });
  assert.match(html, /data-testid="omp-native-hook"/u);
  assert.doesNotMatch(html, /pre-lint\.ts/u);
});

test("同 scope 的有效兼容 MCP 配置与无效主配置同时显示，名称和启停可辨且不泄露秘密", () => {
  // 读取 owner 将有效兼容配置和无效主配置合并为同一来源的条目与错误。
  const mcpServers = [
    {
      name: "compat-enabled",
      scope: "profile" as const,
      enabled: true,
      transport: "http" as const,
      command: "private-server-command",
      url: "https://private-mcp.example.test/secret-token",
      env: { API_KEY: "private-api-key" },
    },
    {
      name: "compat-disabled",
      scope: "profile" as const,
      enabled: false,
      transport: "stdio" as const,
    },
  ];
  const html = renderView({
    kind: "mcp",
    snapshot: { ...snapshot, projectDir: undefined, mcpServers, configErrors: ["profile"] },
  });
  const visibleText = html.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");
  assert.match(visibleText, /mcp\.json 无法解析/u);
  assert.match(visibleText, /compat-enabled http · 已启用/u);
  assert.match(visibleText, /compat-disabled stdio · 已禁用/u);
  assert.doesNotMatch(visibleText, /未发现配置项/u);
  assert.doesNotMatch(
    html,
    /private-server-command|private-mcp|secret-token|API_KEY|private-api-key/u,
  );
});

test("错误来源没有有效 MCP 或钩子时只显示错误，不冒充无配置", () => {
  const mcpHtml = renderView({
    kind: "mcp",
    snapshot: {
      ...snapshot,
      projectDir: undefined,
      mcpServers: [],
      configErrors: ["profile"],
    },
  });
  assert.match(mcpHtml, /mcp\.json 无法解析/u);
  assert.doesNotMatch(mcpHtml, /未发现配置项/u);
  const hookHtml = renderView({
    snapshot: { ...snapshot, projectDir: undefined, hooks: [], hookErrors: ["profile"] },
  });
  assert.match(hookHtml, /钩子目录无法读取/u);
  assert.doesNotMatch(hookHtml, /未发现配置项/u);
});

test("只有当前种类无有效条目且无读取错误时显示空状态", () => {
  const mcpHtml = renderView({
    kind: "mcp",
    snapshot: { ...snapshot, projectDir: undefined, mcpServers: [], hookErrors: ["profile"] },
  });
  assert.match(mcpHtml, /未发现配置项/u);
  assert.doesNotMatch(mcpHtml, /mcp\.json 无法解析|钩子目录无法读取/u);
  const hookHtml = renderView({
    snapshot: { ...snapshot, projectDir: undefined, hooks: [], configErrors: ["profile"] },
  });
  assert.match(hookHtml, /未发现配置项/u);
  assert.doesNotMatch(hookHtml, /mcp\.json 无法解析|钩子目录无法读取/u);
});
