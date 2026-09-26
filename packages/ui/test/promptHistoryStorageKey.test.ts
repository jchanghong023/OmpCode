import assert from "node:assert/strict";
import { test } from "node:test";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
  resolvePromptHistoryStorageKey,
} from "../src/lib/promptHistoryStorage.js";

// F41：prompt history 的 localStorage 键必须走统一身份键
// `workspaceIdentity?.trim() || workspacePath`（AGENTS.md Workspace Identity 红线）。
// 测试注入最小 StorageLike 夹具，避免依赖 window.localStorage。
function createStorageStub() {
  const store = new Map<string, string>();
  return {
    backing: store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

test("身份键 identity 优先，空 identity 回退 workspacePath", () => {
  assert.equal(
    resolvePromptHistoryStorageKey("D:/ws", "remote:abc"),
    "zcode-chat-prompt-history:remote:abc",
  );
  assert.equal(resolvePromptHistoryStorageKey("D:/ws", "   "), "zcode-chat-prompt-history:D:/ws");
  assert.equal(resolvePromptHistoryStorageKey("D:/ws"), "zcode-chat-prompt-history:D:/ws");
});

test("无 identity 的读写与旧路径键一致（本地历史不丢失）", () => {
  const storage = createStorageStub();
  persistPromptHistoryEntries("D:/ws", ["hello"], undefined, storage);
  assert.equal(storage.backing.has("zcode-chat-prompt-history:D:/ws"), true);
  assert.deepEqual(readPromptHistoryEntries("D:/ws", undefined, storage), ["hello"]);
});

test("不同 identity 的历史互相隔离", () => {
  const storage = createStorageStub();
  persistPromptHistoryEntries("D:/ws", ["from-a"], "remote:a", storage);
  assert.deepEqual(readPromptHistoryEntries("D:/ws", "remote:b", storage), []);
  assert.deepEqual(readPromptHistoryEntries("D:/ws", "remote:a", storage), ["from-a"]);
});

test("带 identity 的持久化落在统一身份键上", () => {
  const storage = createStorageStub();
  persistPromptHistoryEntries("D:/ws", ["entry"], "remote:a", storage);
  assert.equal(storage.backing.has("zcode-chat-prompt-history:remote:a"), true);
});
