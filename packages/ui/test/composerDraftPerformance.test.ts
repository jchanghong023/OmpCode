import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createComposerDraftOwner } from "../src/v4/composer/composerDraftOwner.js";
import { createComposerDraftPersistence } from "../src/v4/composer/composerDraftPersistence.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import {
  getSharedComposerDraftOwner,
  migrateSharedComposerDraft,
} from "../src/v4/composer/composerDraftRegistry.js";

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

test("同 scope pane B 恢复时只在边界读取 pane A 的最新富 JSON", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);
  const owner = createComposerDraftOwner({
    workspacePath: "/cross-pane-rich-reader",
    scopeId: "same-scope",
    draft: {
      text: "@same",
      editorStateJson: JSON.stringify({ type: "old-mention", id: "old" }),
      updatedAt: 0,
    },
  });
  const paneA = Symbol("pane-A");
  const paneB = Symbol("pane-B");
  owner.acquireLease(paneA);
  owner.acquireLease(paneB);
  let latestJson = JSON.stringify({ type: "mention", id: "latest", markdown: "@same" });
  let paneAReaderCalls = 0;
  let paneBReaderCalls = 0;
  const unregisterA = owner.registerReader(paneA, () => {
    paneAReaderCalls++;
    return { text: "@same", editorStateJson: latestJson };
  });
  const unregisterB = owner.registerReader(paneB, () => {
    paneBReaderCalls++;
    return {
      text: "@same",
      editorStateJson: JSON.stringify({ type: "stale-pane-initialization", id: "stale" }),
    };
  });
  let paneBEditorJson = owner.draft.editorStateJson;
  let latestJsonEvents = 0;
  const unsubscribeB = owner.subscribe((event) => {
    if (event.kind !== "content" || event.origin === paneB) return;
    paneBEditorJson = event.draft.editorStateJson;
    if (paneBEditorJson === latestJson) latestJsonEvents++;
  });
  t.after(() => {
    unsubscribeB();
    unregisterA();
    unregisterB();
    owner.releaseLease(paneA);
    owner.releaseLease(paneB);
  });

  latestJson = JSON.stringify({ type: "mention", id: "newest", markdown: "@same" });
  owner.markDirty(paneA, undefined, true);
  owner.markDirty(paneA, undefined, true);
  assert.equal(paneAReaderCalls, 0, "富 JSON 不应随每次 dirty 信号序列化");
  assert.equal(paneBReaderCalls, 0, "挂载 pane B 不应以旧初始化结构抢占 reader");
  assert.notEqual(paneBEditorJson, latestJson, "普通 dirty 投影不读取仍在编辑器中的 JSON");

  assert.equal(owner.flush(), true);
  const restoredForPaneB = owner.draft;
  assert.equal(restoredForPaneB.editorStateJson, latestJson);
  assert.equal(paneBEditorJson, latestJson, "合批 flush 边界发布更新后的富结构");
  assert.equal(paneAReaderCalls, 1, "flush 只读取当前有效 reader 一次");
  assert.equal(paneBReaderCalls, 0);

  owner.materialize();
  assert.equal(latestJsonEvents, 1, "实际 JSON 未变化时不重复发布");
  assert.equal(paneAReaderCalls, 2, "pane B 的 programmatic restore 不抢 reader 优先级");
  assert.equal(paneBReaderCalls, 0);
});

test("pending receipt 在另一 pane 新编辑后保留新草稿和原 pending 归属", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);

  for (const outcome of ["accepted", "rejected"] as const) {
    const owner = createComposerDraftOwner({
      workspacePath: `/pending-pane-edit-${outcome}`,
      scopeId: "same-scope",
      draft: { text: "", updatedAt: 0 },
    });
    const paneA = Symbol(`pane-A-${outcome}`);
    const paneB = Symbol(`pane-B-${outcome}`);
    owner.acquireLease(paneA);
    owner.acquireLease(paneB);
    const submitted = {
      text: "A submission",
      editorStateJson: JSON.stringify({ type: "mention", id: "A" }),
    };
    owner.updateContent(paneA, submitted);
    const receipt = owner.captureSubmission(paneA, submitted);
    assert.equal(receipt.claim(), true);
    assert.equal(owner.pendingCount, 1);

    const newer = {
      text: "B next message",
      editorStateJson: JSON.stringify({ type: "mention", id: "B" }),
    };
    owner.updateContent(paneB, newer);
    assert.equal(receipt.hasNewerEdits(), true);
    assert.equal(owner.pendingCount, 1, "pane B 的编辑不能结束 pane A 的 pending receipt");

    if (outcome === "rejected") {
      assert.equal(receipt.rollback(), false, "旧失败不能恢复 A 覆盖 B");
    } else {
      receipt.complete();
    }
    assert.equal(owner.draft.text, newer.text);
    assert.equal(owner.draft.editorStateJson, newer.editorStateJson);
    assert.equal(owner.pendingCount, 0);
    owner.releaseLease(paneA);
    owner.releaseLease(paneB);
  }
});

test("A→B→A 可恢复来源失败，A 的较新编辑阻止旧 receipt 回滚", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);

  for (const editOnReturn of [false, true]) {
    const workspacePath = `/draft-return-${editOnReturn ? "edited" : "unchanged"}`;
    const ownerA = getSharedComposerDraftOwner({ workspacePath, scopeId: "A" });
    const paneA = Symbol("pane-A");
    ownerA.acquireLease(paneA);
    const original = {
      text: "A original",
      editorStateJson: JSON.stringify({ type: "mention", id: "A-original" }),
    };
    ownerA.updateContent(paneA, original);
    const receipt = ownerA.captureSubmission(paneA, original);
    assert.equal(receipt.claim(), true);
    ownerA.releaseLease(paneA);

    getSharedComposerDraftOwner({ workspacePath, scopeId: "B" });
    const returnedA = getSharedComposerDraftOwner({ workspacePath, scopeId: "A" });
    assert.strictEqual(returnedA, ownerA);
    if (editOnReturn) {
      const returnPane = Symbol("pane-A-return");
      returnedA.acquireLease(returnPane);
      returnedA.updateContent(returnPane, {
        text: "A newer edit",
        editorStateJson: JSON.stringify({ type: "mention", id: "A-newer" }),
      });
      assert.equal(receipt.rollback(), false);
      assert.equal(returnedA.draft.text, "A newer edit");
      returnedA.releaseLease(returnPane);
    } else {
      assert.equal(receipt.rollback(), true);
      assert.equal(returnedA.draft.text, original.text);
      assert.equal(returnedA.draft.editorStateJson, original.editorStateJson);
    }
    assert.equal(returnedA.pendingCount, 0);
  }
});

test("迁移时目标初始化配置不胜过来源草稿", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);
  const workspacePath = "/migration-initial-config-test";
  const sourceSelection = {
    providerId: "omp",
    modelId: "source-model",
    options: { reasoningLevel: "high" },
  };
  const initialTargetSelection = {
    providerId: "omp",
    modelId: "initial-target-model",
    options: { reasoningLevel: "off" },
  };
  const sourceJson = JSON.stringify({ type: "mention", id: "source-json" });
  const sourceMention = {
    id: "file:/source",
    category: "files" as const,
    label: "source file",
    value: "/source",
    markdown: "@source",
  };
  persistV4ComposerDraft(workspacePath, undefined, "temporary", {
    text: "source draft",
    editorStateJson: sourceJson,
    mention: sourceMention,
    mode: "build",
    modelSelection: sourceSelection,
  });
  persistV4ComposerDraft(workspacePath, undefined, "uuid", {
    text: "",
    mode: "build",
    modelSelection: initialTargetSelection,
  });
  const targetOwner = getSharedComposerDraftOwner({ workspacePath, scopeId: "uuid" });

  assert.equal(
    migrateSharedComposerDraft({
      workspacePath,
      fromTaskId: "temporary",
      toTaskId: "uuid",
    }),
    true,
  );
  const migrated = readV4ComposerDraft(workspacePath, undefined, "uuid");
  assert.equal(migrated?.text, "source draft");
  assert.equal(migrated?.editorStateJson, sourceJson);
  assert.deepEqual(migrated?.mention, sourceMention);
  assert.equal(targetOwner.draft.text, "source draft");
  assert.equal(targetOwner.draft.editorStateJson, sourceJson);
  assert.deepEqual(targetOwner.draft.mention, sourceMention);
  assert.deepEqual(targetOwner.draft.modelSelection, sourceSelection);
  assert.equal(readV4ComposerDraft(workspacePath, undefined, "temporary"), null);
});

test("迁移保留目标 pane 的显式模型或思考意图及 OMP 比较游标", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);

  for (const edited of ["model", "thought"] as const) {
    const workspacePath = `/migration-manual-config-${edited}`;
    const baseline = {
      providerId: "omp",
      modelId: "session-model",
      options: { reasoningLevel: "off" },
    };
    const manualSelection =
      edited === "model"
        ? {
            providerId: "omp",
            modelId: "manually-selected-model",
            options: { reasoningLevel: "high" },
          }
        : {
            providerId: "omp",
            modelId: "session-model",
            options: { reasoningLevel: "max" },
          };
    const sourceJson = JSON.stringify({ type: "mention", id: `source-${edited}` });
    const sourceMention = {
      id: `file:/source-${edited}`,
      category: "files" as const,
      label: "source file",
      value: `/source-${edited}`,
      markdown: `@source-${edited}`,
    };
    persistV4ComposerDraft(workspacePath, undefined, "temporary", {
      text: "source draft",
      editorStateJson: sourceJson,
      mention: sourceMention,
      mode: "build",
      modelSelection: {
        providerId: "omp",
        modelId: "source-model",
        options: { reasoningLevel: "high" },
      },
    });
    persistV4ComposerDraft(workspacePath, undefined, "uuid", {
      text: "",
      mode: "build",
      modelSelection: baseline,
      ompModelBaseline: baseline,
    });
    const targetOwner = getSharedComposerDraftOwner({ workspacePath, scopeId: "uuid" });
    targetOwner.updateConfig((current) => ({
      ...current,
      modelSelection: manualSelection,
      ...(edited === "model"
        ? { ompModelEdited: true as const }
        : { ompThoughtEdited: true as const }),
    }));

    assert.equal(
      migrateSharedComposerDraft({
        workspacePath,
        fromTaskId: "temporary",
        toTaskId: "uuid",
      }),
      true,
    );
    const migrated = readV4ComposerDraft(workspacePath, undefined, "uuid");
    assert.equal(migrated?.text, "source draft");
    assert.equal(migrated?.editorStateJson, sourceJson);
    assert.deepEqual(migrated?.mention, sourceMention);
    assert.deepEqual(migrated?.modelSelection, manualSelection);
    assert.deepEqual(migrated?.ompModelBaseline, baseline);
    assert.equal(migrated?.ompModelEdited, edited === "model" ? true : undefined);
    assert.equal(migrated?.ompThoughtEdited, edited === "thought" ? true : undefined);
    assert.equal(targetOwner.draft.text, "source draft");
    assert.equal(targetOwner.draft.editorStateJson, sourceJson);
    assert.deepEqual(targetOwner.draft.mention, sourceMention);
    assert.equal(readV4ComposerDraft(workspacePath, undefined, "temporary"), null);
  }
});

test("目标较新内容冲突仍整份优先并保留来源备份", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);
  const workspacePath = "/migration-newer-content";
  const sourceJson = JSON.stringify({ type: "mention", id: "source" });
  const targetJson = JSON.stringify({ type: "mention", id: "target" });
  const sourceMention = {
    id: "file:/source",
    category: "files" as const,
    label: "source",
    value: "/source",
    markdown: "@source",
  };
  const targetMention = {
    id: "file:/target",
    category: "files" as const,
    label: "target",
    value: "/target",
    markdown: "@target",
  };
  persistV4ComposerDraft(workspacePath, undefined, "temporary", {
    text: "source body",
    editorStateJson: sourceJson,
    mention: sourceMention,
    mode: "build",
  });
  persistV4ComposerDraft(workspacePath, undefined, "uuid", {
    text: "newer target body",
    editorStateJson: targetJson,
    mention: targetMention,
    mode: "build",
  });

  assert.equal(
    migrateSharedComposerDraft({
      workspacePath,
      fromTaskId: "temporary",
      toTaskId: "uuid",
    }),
    true,
  );
  const migrated = readV4ComposerDraft(workspacePath, undefined, "uuid");
  assert.equal(migrated?.text, "newer target body");
  assert.equal(migrated?.editorStateJson, targetJson);
  assert.deepEqual(migrated?.mention, targetMention);
  assert.equal(readV4ComposerDraft(workspacePath, undefined, "temporary")?.text, "source body");
});

test("pending target 在迁移时保留 receipt 与来源备份", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  storageFixture(t);
  const workspacePath = "/migration-pending-target";
  const sourceJson = JSON.stringify({ type: "mention", id: "source" });
  persistV4ComposerDraft(workspacePath, undefined, "temporary", {
    text: "source body",
    editorStateJson: sourceJson,
    mode: "build",
  });
  const targetOwner = getSharedComposerDraftOwner({ workspacePath, scopeId: "uuid" });
  const targetPane = Symbol("pending-target");
  targetOwner.acquireLease(targetPane);
  const pendingDraft = {
    text: "pending target body",
    editorStateJson: JSON.stringify({ type: "mention", id: "pending-target" }),
  };
  targetOwner.updateContent(targetPane, pendingDraft);
  const receipt = targetOwner.captureSubmission(targetPane, pendingDraft);
  assert.equal(receipt.claim(), true);

  assert.equal(
    migrateSharedComposerDraft({
      workspacePath,
      fromTaskId: "temporary",
      toTaskId: "uuid",
    }),
    true,
  );
  assert.equal(targetOwner.pendingCount, 1);
  assert.equal(receipt.rollback(), true, "迁移不应使原 target receipt 失效");
  assert.equal(targetOwner.draft.text, pendingDraft.text);
  assert.equal(targetOwner.draft.editorStateJson, pendingDraft.editorStateJson);
  assert.equal(targetOwner.pendingCount, 0);
  assert.equal(readV4ComposerDraft(workspacePath, undefined, "temporary")?.text, "source body");
  targetOwner.releaseLease(targetPane);
});

test("配置意图迁移的 Storage 失败保留双 owner，重试后只迁移一次合并草稿", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const storage = storageFixture(t);
  const workspacePath = "/migration-config-storage-retry";
  const sourceSelection = {
    providerId: "omp",
    modelId: "source-model",
    options: { reasoningLevel: "high" },
  };
  const manualSelection = {
    providerId: "omp",
    modelId: "target-manual-model",
    options: { reasoningLevel: "max" },
  };
  persistV4ComposerDraft(workspacePath, undefined, "temporary", {
    text: "source body",
    editorStateJson: JSON.stringify({ type: "mention", id: "source" }),
    mode: "build",
    modelSelection: sourceSelection,
  });
  persistV4ComposerDraft(workspacePath, undefined, "uuid", {
    text: "",
    mode: "build",
    modelSelection: {
      providerId: "omp",
      modelId: "initial-target",
      options: { reasoningLevel: "off" },
    },
  });
  const sourceOwner = getSharedComposerDraftOwner({ workspacePath, scopeId: "temporary" });
  const targetOwner = getSharedComposerDraftOwner({ workspacePath, scopeId: "uuid" });
  targetOwner.updateConfig((current) => ({
    ...current,
    modelSelection: manualSelection,
    ompModelEdited: true,
  }));

  storage.setFailure(true);
  const migrationParams = {
    workspacePath,
    fromTaskId: "temporary",
    toTaskId: "uuid",
  };
  assert.equal(migrateSharedComposerDraft(migrationParams), false);
  assert.strictEqual(
    getSharedComposerDraftOwner({ workspacePath, scopeId: "temporary" }),
    sourceOwner,
  );
  assert.equal(sourceOwner.draft.text, "source body");
  assert.equal(targetOwner.draft.text, "");

  storage.setFailure(false);
  assert.equal(migrateSharedComposerDraft(migrationParams), true);
  assert.equal(targetOwner.draft.text, "source body");
  assert.equal(targetOwner.draft.modelSelection?.modelId, "target-manual-model");
  assert.equal(readV4ComposerDraft(workspacePath, undefined, "temporary"), null);
  assert.equal(readV4ComposerDraft(workspacePath, undefined, "uuid")?.text, "source body");
});
