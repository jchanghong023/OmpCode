import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_TAB_ID, createTabStore } from "../src/store/tabStore.js";

function createMemoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

test("Settings 激活时关闭后台 workspace tab，保持最近激活 workspace 不被改写", () => {
  const store = createTabStore(createMemoryStorage());
  store.getState().addTab("/ws/a", { workspaceIdentity: "id-a" });
  const tabB = store.getState().addTab("/ws/b", { workspaceIdentity: "id-b" });
  store.getState().openSettingsTab();

  assert.equal(store.getState().activeTabId, SETTINGS_TAB_ID);
  assert.equal(store.getState().activeWorkspacePath, "/ws/b");
  assert.equal(store.getState().activeWorkspaceIdentity, "id-b");

  // 关闭的是后台（非激活）workspace tab，激活 tab 仍是 Settings
  store.getState().closeTab(tabB);

  assert.equal(store.getState().tabs.length, 2);
  assert.equal(store.getState().activeTabId, SETTINGS_TAB_ID);
  // 修复 F8：不应回落到剩余第一个 workspace（/ws/a），必须保留最近激活值
  assert.equal(store.getState().activeWorkspacePath, "/ws/b");
  assert.equal(store.getState().activeWorkspaceIdentity, "id-b");
});

test("激活 workspace tab 被关且接替 tab 是 Settings 时，回落到剩余第一个 workspace", () => {
  const store = createTabStore(createMemoryStorage());
  store.getState().addTab("/ws/b", { workspaceIdentity: "id-b" });
  store.getState().openSettingsTab();
  const tabA = store.getState().addTab("/ws/a", { workspaceIdentity: "id-a" });
  // 排成 [a, settings, b]，让 a 的相邻接替 tab 是 Settings，剩余列表里还有 b
  store.getState().reorderTabs(2, 1);
  assert.deepEqual(
    store.getState().tabs.map((tab) => tab.kind),
    ["workspace", "settings", "workspace"],
  );

  store.getState().closeTab(tabA);

  assert.equal(store.getState().activeTabId, SETTINGS_TAB_ID);
  // 分支二既有语义：关闭激活 workspace 且接替非 workspace 时，取剩余第一个 workspace
  assert.equal(store.getState().activeWorkspacePath, "/ws/b");
  assert.equal(store.getState().activeWorkspaceIdentity, "id-b");
});

test("激活 workspace tab 被关且接替 tab 是另一 workspace 时，使用接替 tab 的 path 和 identity", () => {
  const store = createTabStore(createMemoryStorage());
  store.getState().addTab("/ws/b", { workspaceIdentity: "id-b" });
  const tabA = store.getState().addTab("/ws/a", { workspaceIdentity: "id-a" });
  assert.equal(store.getState().activeWorkspacePath, "/ws/a");

  store.getState().closeTab(tabA);

  assert.equal(store.getState().tabs.length, 1);
  // 分支一既有语义：接替激活 tab 是 workspace 时直接采用它的 path / identity
  assert.equal(store.getState().activeWorkspacePath, "/ws/b");
  assert.equal(store.getState().activeWorkspaceIdentity, "id-b");
  assert.equal(store.getState().activeTabId, store.getState().tabs[0]?.id);
});
