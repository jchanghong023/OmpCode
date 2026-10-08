import assert from "node:assert/strict";
import { test } from "node:test";
import { createSelectionSideChat } from "../src/lib/selectionSideChatRuntime.js";
import { openSavedSidePane, subscribeSavedSidePanes } from "../src/lib/OmpBtwPaneRuntime.js";
import type { OpenSelectionSideChatRequest } from "../src/lib/workspaceSidePane.js";
import {
  openSelectionSideChatPane,
  getActiveSelectionSideChatTab,
  isSidePaneTabVisibleForParent,
  normalizeWorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";
import {
  mergeOmpBtwSlashSuggestions,
  resolveOmpBtwComposerCommand,
  routeOmpBtwComposerInput,
} from "../src/lib/OmpBtwComposerRouting.js";
import {
  buildAppSlashCommandSuggestions,
  buildSlashSuggestions,
  isAppSlashCommandSuggestion,
  type AppSlashCommand,
} from "../src/slashCommandHelpers.js";
import { attachmentRefSchema } from "@zcode/shared/zcode-protocol-v4";

// 公开 UI 身份 seam；真实 renderer/GUI 流式验收另行执行。
test("pending first input preserves stable parent/topic metadata without duplicate creation", async () => {
  let release: ((value: { childSessionId: string; parentSessionId: string }) => void) | undefined;
  let calls = 0;
  const create = () => {
    calls++;
    return new Promise<{ childSessionId: string; parentSessionId: string }>((resolve) => {
      release = resolve;
    });
  };
  const first = createSelectionSideChat("remote-workspace\0parent\0prompt", create);
  const duplicate = createSelectionSideChat("remote-workspace\0parent\0prompt", create);
  release!({ childSessionId: "opaque-saved-topic", parentSessionId: "stable-parent" });
  assert.deepEqual(await first, {
    childSessionId: "opaque-saved-topic",
    parentSessionId: "stable-parent",
  });
  assert.deepEqual(await duplicate, await first);
  assert.equal(calls, 1);
});

test("side tab binding preserves workspace identity, remote route and replaced draft", () => {
  const received: OpenSelectionSideChatRequest[] = [];
  const off = subscribeSavedSidePanes((request) => received.push(request));
  const request: OpenSelectionSideChatRequest = {
    workspacePath: "/same/path",
    workspaceIdentity: "remote-workspace",
    remoteSessionId: "remote-connection",
    parentSessionId: "stable-parent",
    childSessionId: "opaque-saved-topic",
    replacesChildSessionId: "opaque-draft",
  };
  openSavedSidePane(request);
  assert.deepEqual(received, [request]);
  off();
  openSavedSidePane({ ...request, childSessionId: "another-topic" });
  assert.deepEqual(received, [request]);
});

test("stable saved topic stays visible to the live draft-parent alias and to the cold parent", () => {
  const scope = {
    workspacePath: "/workspace",
    workspaceKey: "remote-workspace",
    parentSessionId: "stable-parent",
    liveParentSessionId: "live-parent",
    childSessionId: "opaque-saved-topic",
  };
  const state = openSelectionSideChatPane(null, scope);
  const tab = getActiveSelectionSideChatTab(state, {
    workspaceKey: scope.workspaceKey,
    parentSessionId: "live-parent",
  })!;
  assert.equal(tab.parentSessionId, "stable-parent");
  assert.ok(isSidePaneTabVisibleForParent(tab, "live-parent"));
  assert.ok(isSidePaneTabVisibleForParent(tab, "stable-parent"));
  assert.equal(isSidePaneTabVisibleForParent(tab, "other-parent"), false);
  assert.equal(
    getActiveSelectionSideChatTab(state, {
      workspaceKey: "other-workspace",
      parentSessionId: "live-parent",
    }),
    null,
  );
  const reused = openSelectionSideChatPane(state, { ...scope, parentSessionId: "live-parent" });
  assert.equal(reused.tabs.length, 1);
  assert.equal(reused.tabs[0]!.id, tab.id);
  assert.equal(normalizeWorkspaceSidePaneState(reused)?.tabs.length, 1);
  // 旧实现的普通 child 仅撤去 tab，不删除原会话或冒充原生辅助主题。
  const legacy = { ...tab, childSessionId: "ordinary-old-session", sideTopicVersion: undefined };
  assert.equal(normalizeWorkspaceSidePaneState({ tabs: [legacy], activeTabId: legacy.id }), null);
});

const auxiliaryCommands: AppSlashCommand[] = [
  { value: "side", description: "GUI auxiliary", run() {} },
  { value: "btw", description: "GUI auxiliary alias", run() {} },
];

test("real composer router consumes both bare aliases and submits only the parameter body", async () => {
  const questions: string[] = [];
  const open = async (question: string) => {
    questions.push(question);
    return true;
  };
  for (const text of [
    "/btw",
    "/side  ",
    "  /BTW first  line\nsecond line  ",
    "/side next question",
  ]) {
    const pending = routeOmpBtwComposerInput(text, auxiliaryCommands, undefined, open);
    assert.ok(pending, "a reserved GUI alias must not fall through to native main prompt");
    assert.equal(await pending, "sent");
  }
  assert.deepEqual(questions, ["", "", "first  line\nsecond line", "next question"]);
});

test("auxiliary aliases match complete command names, not main commands or embedded text", () => {
  for (const text of [
    "/btw-extra question",
    "/sidecar",
    "ordinary /btw text",
    "/model glm",
    "/plan task",
    "/goal task",
    "/hello-ext",
  ]) {
    assert.equal(resolveOmpBtwComposerCommand(text, auxiliaryCommands), null);
    assert.equal(
      routeOmpBtwComposerInput(text, auxiliaryCommands, undefined, async () => {
        assert.fail("non-alias input must not open a side pane");
      }),
      null,
    );
  }
  assert.equal(resolveOmpBtwComposerCommand("/btw question", undefined), null);
  assert.equal(resolveOmpBtwComposerCommand("/btw question", auxiliaryCommands.slice(0, 1)), null);
});

test("real composer router rejects legal ready attachments and structured contexts without consuming their draft", async () => {
  const attachment = attachmentRefSchema.parse({
    ref: "attachment://ready-text",
    fileName: "notes.txt",
    mime: "text/plain",
    bytes: 7,
  });
  let opened = 0;
  const open = async () => {
    opened++;
    return true;
  };
  for (const options of [
    { attachments: [attachment] },
    { contextAttachmentCount: 1 },
    { sharedContextRefs: [{ kind: "shared_context_import", context_id: "saved-context" }] },
  ]) {
    const before = structuredClone(options);
    const pending = routeOmpBtwComposerInput(
      "/btw keep my question",
      auxiliaryCommands,
      options,
      open,
    );
    assert.ok(pending);
    await assert.rejects(pending, /不支持附件或结构化上下文/);
    assert.deepEqual(options, before);
  }
  assert.equal(opened, 0);
});

test("auxiliary creation rejection stays blocked or rejects instead of falling through to main send", async () => {
  const blocked = routeOmpBtwComposerInput("/btw", auxiliaryCommands, undefined, async () => false);
  assert.ok(blocked);
  assert.equal(await blocked, "blocked");
  const failure = new Error("real create command rejected");
  const rejected = routeOmpBtwComposerInput(
    "/side question",
    auxiliaryCommands,
    undefined,
    async () => {
      throw failure;
    },
  );
  assert.ok(rejected);
  await assert.rejects(rejected, (error) => error === failure);
});

test("actual slash-panel merge gives only advertised btw/side local suggestions priority", () => {
  const nativeCatalog = [
    { name: "btw", description: "Native BTW terminal command" },
    { name: "side", description: "Native side command" },
    { name: "model", description: "Native model" },
    { name: "plan", description: "Native plan" },
    { name: "goal", description: "Native goal" },
  ];
  const nativeBefore = structuredClone(nativeCatalog);
  const nativeItems = buildSlashSuggestions(nativeCatalog);
  const appItems = buildAppSlashCommandSuggestions([
    ...auxiliaryCommands,
    ...["model", "plan", "goal", "extra-ui"].map((value) => ({
      value,
      description: "Other app command",
      run() {},
    })),
  ]);
  const merged = mergeOmpBtwSlashSuggestions(nativeItems, appItems);
  for (const alias of ["btw", "side"]) {
    const matches = merged.filter((item) => item.value === alias);
    assert.equal(matches.length, 1);
    assert.equal(isAppSlashCommandSuggestion(matches[0]!), true);
  }
  for (const nativeName of ["model", "plan", "goal"]) {
    const matches = merged.filter((item) => item.value === nativeName);
    assert.equal(matches.length, 1);
    assert.equal(isAppSlashCommandSuggestion(matches[0]!), false);
  }
  assert.equal(
    merged.some((item) => item.value === "extra-ui"),
    true,
  );
  assert.deepEqual(nativeCatalog, nativeBefore);
  assert.equal(mergeOmpBtwSlashSuggestions(nativeItems, []), nativeItems);
  const withoutReservedAlias = mergeOmpBtwSlashSuggestions(
    nativeItems,
    buildAppSlashCommandSuggestions(auxiliaryCommands.slice(0, 1)),
  );
  assert.equal(
    isAppSlashCommandSuggestion(withoutReservedAlias.find((item) => item.value === "btw")!),
    false,
  );
});
