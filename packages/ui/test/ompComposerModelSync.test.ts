import assert from "node:assert/strict";
import test from "node:test";
import { applyOmpComposerModelSync } from "../src/v4/composer/OmpComposerModelSync.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

const initial = { provider: "fixture", model: "execution", thought: "off" };
const plan = { provider: "fixture", model: "planning", thought: "high" };
const selection = (modelId: string, reasoningLevel: string) => ({
  providerId: "fixture",
  modelId,
  options: { reasoningLevel },
});
const draft: V4ComposerDraft = {
  text: "unsent draft",
  mode: "build",
  updatedAt: 0,
  modelSelection: selection("execution", "max"),
};

test("新任务最高思考档不阻止 /plan 临时模型及批准后恢复的事实回投", () => {
  const seeded = applyOmpComposerModelSync(draft, initial);
  assert.equal(seeded.modelSelection, draft.modelSelection);
  const planning = applyOmpComposerModelSync(seeded, plan);
  assert.deepEqual(planning.modelSelection, selection("planning", "high"));
  assert.equal(planning.text, "unsent draft");
  assert.equal(applyOmpComposerModelSync(planning, plan), planning);
  const restored = applyOmpComposerModelSync(planning, initial);
  assert.deepEqual(restored.modelSelection, selection("execution", "off"));
});

test("原生模型事实优先于旧提交 intent，缺少模型事实时保持草稿", () => {
  const seeded = applyOmpComposerModelSync(draft, initial);
  assert.deepEqual(
    applyOmpComposerModelSync(seeded, { ...plan, modelSelection: draft.modelSelection })
      .modelSelection,
    selection("planning", "high"),
  );
  assert.equal(applyOmpComposerModelSync(seeded, { provider: "", model: "" }), seeded);
});

test("用户显式模型与思考档意图分别保留，快照更新不伪造另一次编辑", () => {
  const seeded = applyOmpComposerModelSync(draft, initial);
  const manuallySelected = {
    ...seeded,
    modelSelection: selection("next", "max"),
    ompModelEdited: true as const,
  };
  const preserved = applyOmpComposerModelSync(manuallySelected, plan);
  assert.equal(preserved.modelSelection, manuallySelected.modelSelection);
  assert.deepEqual(preserved.ompModelBaseline, selection("planning", "high"));
  const thoughtEdited = { ...seeded, ompThoughtEdited: true as const };
  assert.deepEqual(
    applyOmpComposerModelSync(thoughtEdited, plan).modelSelection,
    selection("planning", "max"),
  );
});

test("冷恢复保留比较游标与编辑标记，已保存旧模型可随真实恢复事实更新", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  try {
    const planning = applyOmpComposerModelSync(applyOmpComposerModelSync(draft, initial), plan);
    assert.equal(persistV4ComposerDraft("C:/fixture", undefined, "session", planning), true);
    const cold = readV4ComposerDraft("C:/fixture", undefined, "session")!;
    assert.deepEqual(
      applyOmpComposerModelSync(cold, initial).modelSelection,
      selection("execution", "off"),
    );
    assert.equal(
      persistV4ComposerDraft("C:/fixture", undefined, "session", {
        ...planning,
        modelSelection: selection("next", "max"),
        ompModelEdited: true,
        ompThoughtEdited: true,
      }),
      true,
    );
    const edited = readV4ComposerDraft("C:/fixture", undefined, "session")!;
    assert.equal(edited.ompThoughtEdited, true);
    assert.equal(applyOmpComposerModelSync(edited, initial).modelSelection, edited.modelSelection);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
