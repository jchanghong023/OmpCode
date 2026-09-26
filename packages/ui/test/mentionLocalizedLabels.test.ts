import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { mapSubagentsToMentionItemsForTest } from "../src/mentions/providers/subagentsMentionProvider.js";
import { collectSessionMentionItems } from "../src/mentions/providers/sessionsMentionProvider.js";

test("subagent mention 来源标签随 locale 本地化", () => {
  const agents = [
    {
      id: "1",
      name: "workspace-agent",
      description: "desc",
      path: "p",
      scope: "workspace",
      source: "user",
      enabled: true,
    },
    {
      id: "2",
      name: "plugin-agent",
      description: "desc",
      path: "p",
      scope: "user",
      source: "plugin",
      enabled: true,
    },
    {
      id: "3",
      name: "builtin-agent",
      description: "desc",
      path: "p",
      scope: "built-in",
      source: "built-in",
      enabled: true,
    },
    {
      id: "4",
      name: "user-agent",
      description: "desc",
      path: "p",
      scope: "user",
      source: "user",
      enabled: true,
    },
  ] as const;

  const zhItems = mapSubagentsToMentionItemsForTest([...agents], "zh-CN");
  assert.deepEqual(
    zhItems.map((item) => item.description),
    ["工作区 · desc", "插件 · desc", "内置 · desc", "用户 · desc"],
  );

  const enItems = mapSubagentsToMentionItemsForTest([...agents], "en-US");
  assert.deepEqual(
    enItems.map((item) => item.description),
    ["Workspace · desc", "Plugin · desc", "Built-in · desc", "User · desc"],
  );
});

function buildTask(title: string): ZCodeTaskMeta {
  return {
    taskId: "sess_1",
    traceId: "sess_1",
    title,
    workspacePath: "D:/ws",
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
  };
}

test("session mention 空标题（含仅剩 #sess_ 前缀）回退本地化文案", () => {
  const items = collectSessionMentionItems([buildTask("#sess_abc123   ")], "glm", {
    untitledLabel: "未命名会话",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.label, "未命名会话");
  assert.ok(items[0]?.markdown.includes("未命名会话"));
});

test("session mention 非空标题保持原文", () => {
  const items = collectSessionMentionItems([buildTask("修复登录 bug")], "glm", {
    untitledLabel: "未命名会话",
  });
  assert.equal(items[0]?.label, "修复登录 bug");
});
