import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createComposerDraftOwner } from "../src/v4/composer/composerDraftOwner.js";
import { createComposerDraftPersistence } from "../src/v4/composer/composerDraftPersistence.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

function storageFixture(t: TestContext) {
  const values = new Map<string, string>();
  const counts = { reads: 0, writes: 0 };
  let failWrites = false;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string) {
          counts.reads++;
          return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          if (failWrites) throw new Error("synthetic storage failure");
          counts.writes++;
          values.set(key, value);
        },
        removeItem(key: string) {
          counts.writes++;
          values.delete(key);
        },
      },
    },
  });
  return {
    counts,
    setFailure(value: boolean) {
      failWrites = value;
    },
  };
}

test("100 个长草稿、30 次正文编辑只合批一次 Storage 读写与 JSON 读取，内容完整", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const storage = storageFixture(t);
  for (let index = 0; index < 100; index++) {
    persistV4ComposerDraft("/network/workspace", undefined, `session-${index}`, {
      text: "字".repeat(10000),
      mode: "build",
    });
  }
  storage.counts.reads = storage.counts.writes = 0;
  const owner = createComposerDraftOwner({
    workspacePath: "/network/workspace",
    scopeId: "session-0",
    draft: { text: "", mode: "build", updatedAt: 0 },
  });
  let jsonReads = 0;
  owner.contentReader = () => {
    jsonReads++;
    return { text: owner.draft.text, editorStateJson: JSON.stringify({ text: owner.draft.text }) };
  };
  for (let index = 1; index <= 30; index++) {
    owner.draft = { ...owner.draft, text: "新".repeat(index) };
    owner.schedule();
    t.mock.timers.tick(10);
  }
  assert.deepEqual(storage.counts, { reads: 0, writes: 0 });
  assert.equal(jsonReads, 0);
  t.mock.timers.tick(350);
  assert.deepEqual(storage.counts, { reads: 1, writes: 1 });
  assert.equal(jsonReads, 1);
  const saved = readV4ComposerDraft("/network/workspace", undefined, "session-0");
  assert.equal(saved?.text, "新".repeat(30));
  assert.deepEqual(JSON.parse(saved!.editorStateJson!), { text: saved?.text });
  assert.equal(
    readV4ComposerDraft("/network/workspace", undefined, "session-99")?.text.length,
    10000,
  );
});

test("持续输入每 2 秒保存最新正文，停止输入再保存最终值", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let latest = 0;
  const written: number[] = [];
  const persistence = createComposerDraftPersistence({
    write: () => {
      written.push(latest);
      return true;
    },
  });
  for (let index = 1; index <= 45; index++) {
    latest = index;
    persistence.schedule();
    t.mock.timers.tick(100);
  }
  assert.deepEqual(written, [20, 40]);
  t.mock.timers.tick(350);
  assert.deepEqual(written, [20, 40, 45]);
});

test("切 scope flush、发送占用与失败恢复不受旧 JSON 覆盖，同路径不同 identity 隔离", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);
  const owner = createComposerDraftOwner({
    workspacePath: "/same",
    workspaceIdentity: "remote-A",
    scopeId: "old",
    draft: { text: "含提及草稿", mode: "build", updatedAt: 0 },
  });
  owner.contentReader = () => ({ text: "含提及草稿", editorStateJson: "structured-mention" });
  owner.schedule();
  assert.equal(owner.flush(), true);
  const submitted = { ...owner.draft };
  owner.draft = { ...owner.draft, text: "", editorStateJson: undefined };
  owner.schedule();
  owner.flush();
  assert.equal(readV4ComposerDraft("/same", "remote-A", "old")?.text, "");
  assert.equal(readV4ComposerDraft("/same", "remote-A", "old")?.editorStateJson, undefined);
  owner.draft = submitted;
  owner.schedule();
  owner.flush();
  const next = createComposerDraftOwner({
    workspacePath: "/same",
    workspaceIdentity: "remote-B",
    scopeId: "new",
    draft: { text: "其他 identity", mode: "build", updatedAt: 0 },
  });
  next.schedule();
  next.flush();
  t.mock.timers.tick(3000);
  assert.equal(
    readV4ComposerDraft("/same", "remote-A", "old")?.editorStateJson,
    "structured-mention",
  );
  assert.equal(readV4ComposerDraft("/same", "remote-B", "new")?.text, "其他 identity");
  assert.equal(readV4ComposerDraft("/same", "remote-B", "old"), null);
});

test("写入失败保留内存与 dirty 状态，后续边界 flush 成功后恢复最新值", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const storage = storageFixture(t);
  const owner = createComposerDraftOwner({
    workspacePath: "/failure",
    scopeId: "s",
    draft: { text: "原值", mode: "build", updatedAt: 0 },
  });
  owner.schedule();
  owner.flush();
  storage.setFailure(true);
  owner.draft = { ...owner.draft, text: "待保存最新值" };
  owner.schedule();
  assert.equal(owner.flush(), false);
  assert.equal(owner.draft.text, "待保存最新值");
  assert.equal(readV4ComposerDraft("/failure", undefined, "s")?.text, "原值");
  storage.setFailure(false);
  assert.equal(owner.flush(), true);
  assert.equal(readV4ComposerDraft("/failure", undefined, "s")?.text, "待保存最新值");
  const writes = storage.counts.writes;
  owner.flush();
  t.mock.timers.tick(3000);
  assert.equal(storage.counts.writes, writes);
});

test("Markdown 相同的富节点改动通过 dirty 信号保存最新 JSON，空闲 flush 不重复序列化", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const storage = storageFixture(t);
  const owner = createComposerDraftOwner({
    workspacePath: "/rich",
    scopeId: "s",
    draft: { text: "@same-path", mode: "build", updatedAt: 0 },
  });
  let json = JSON.stringify({ type: "text", text: "@same-path" });
  let reads = 0;
  owner.contentReader = () => {
    reads++;
    return { text: "@same-path", editorStateJson: json };
  };
  owner.schedule();
  owner.flush();
  json = JSON.stringify({
    type: "mention",
    id: "new-identity",
    label: "新标签",
    markdown: "@same-path",
  });
  // 此时没有正文 onChange；Lexical onContentDirty 只调度相同 owner。
  owner.schedule();
  assert.equal(reads, 1);
  owner.flush();
  assert.equal(readV4ComposerDraft("/rich", undefined, "s")?.editorStateJson, json);
  assert.equal(storage.counts.writes, 2);
  owner.flush();
  assert.equal(reads, 2);
});

test("Storage 持续失败后普通按键仍合批重试，不退化为逐按键 0ms 写入", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let attempts = 0;
  const persistence = createComposerDraftPersistence({
    write: () => {
      attempts++;
      return false;
    },
  });
  for (let index = 0; index < 45; index++) {
    persistence.schedule();
    t.mock.timers.tick(100);
  }
  assert.equal(attempts, 2);
  t.mock.timers.tick(350);
  assert.equal(attempts, 3);
  persistence.flush();
  assert.equal(attempts, 4, "明确生命周期边界仍可立即重试");
});
