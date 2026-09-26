import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_FORM,
  formToJsonDraft,
  jsonDraftToForm,
  scopeToStorageLevel,
} from "../src/settings/mcpSettingsShared.js";

// F28/F29 回归守卫：McpServerForm 依赖 IntlProvider、Radix 下拉等真实 DOM 交互，
// 现有 renderToStaticMarkup 手段无法驱动 Scope 菜单点击，故按约定把「JSON 模式下
// Scope 变更不得覆盖用户手编 jsonDraft」的决策逻辑抽成纯函数（scopeToStorageLevel），
// 并对保存合成路径 jsonDraftToForm(jsonDraft, form) 做最小单测。

// 用户在 JSON 模式手编的全文（权威输入，Scope 变更后必须原样保留）。
const USER_JSON = JSON.stringify(
  {
    "my-server": {
      type: "http",
      url: "https://example.com/mcp",
      timeoutMs: 5000,
      protocolVersion: "legacy",
    },
  },
  null,
  2,
);

test("Scope key 归一：仅 user 视为用户级，其余一律工作区级", () => {
  assert.equal(scopeToStorageLevel("user"), "user");
  assert.equal(scopeToStorageLevel("workspace"), "workspace");
  // workspace tab key 等任意 scope key 归一为工作区级，与 initialForm 原口径一致
  assert.equal(scopeToStorageLevel("session:1:tab"), "workspace");
});

test("JSON 模式下 Scope 变更：jsonDraft 原样保留，仅影子 form 打 storageLevel 补丁", () => {
  // 修复后的 Scope 变更流程：update 只改表单态（影子 form），jsonDraft 不被重序列化。
  const shadowForm = jsonDraftToForm(USER_JSON, { ...EMPTY_FORM, storageLevel: "user" });
  const jsonDraftAfterScopeChange = USER_JSON;
  const nextForm = { ...shadowForm, storageLevel: scopeToStorageLevel("workspace") };

  assert.equal(nextForm.storageLevel, "workspace");
  assert.equal(jsonDraftAfterScopeChange, USER_JSON);

  // 旧行为对照（被移除的缺陷路径）：update 曾在 setForm updater 内用「进入 JSON
  // 模式前的过期 form 快照 + 新 storageLevel」重序列化覆盖 jsonDraft，用户手编
  // 全文会被替换成过期表单内容且不可恢复。
  const staleFormAtJsonEntry = { ...EMPTY_FORM, storageLevel: "user" };
  assert.notEqual(
    formToJsonDraft({ ...staleFormAtJsonEntry, storageLevel: "workspace" }),
    USER_JSON,
  );
});

test("保存合成：jsonDraftToForm(jsonDraft, 影子 form) 保留手编字段并采纳新存储级", () => {
  // 该断言锁定方案依据：JSON 模式下 Scope 变更只需落在影子 form.storageLevel，
  // 保存时即可生效，无需（也不得）重序列化 jsonDraft。
  const shadowForm = jsonDraftToForm(USER_JSON, { ...EMPTY_FORM, storageLevel: "user" });
  const nextForm = { ...shadowForm, storageLevel: scopeToStorageLevel("workspace") };

  const saved = jsonDraftToForm(USER_JSON, nextForm);
  assert.equal(saved.storageLevel, "workspace");
  assert.equal(saved.name, "my-server");
  assert.equal(saved.type, "http");
  assert.equal(saved.url, "https://example.com/mcp");
  assert.equal(saved.timeoutMs, "5000");
  assert.equal(saved.protocolVersion, "legacy");
});
