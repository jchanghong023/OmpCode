import assert from "node:assert/strict";
import test from "node:test";
import { captureComposerRecentSubmission, readComposerRecent } from "../src/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

test("运行 profile 隔离正文和 Recent，默认键保留且切回恢复原值", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const runtime = { localStorage, __OMP_ACTIVE_PROFILE__: "default" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: runtime });
  try {
    const workspace = "/workspace";
    const selection = { providerId: "fixture", modelId: "default-model" };
    persistV4ComposerDraft(workspace, undefined, "__draft__", { text: "default draft" });
    captureComposerRecentSubmission(workspace, { modelSelection: selection, mode: "build" })();
    assert.ok(values.has("zcode-v4-composer-drafts:v1:%2Fworkspace"));
    assert.ok(values.has("zcode-model-selection-recent-v1:/workspace"));
    runtime.__OMP_ACTIVE_PROFILE__ = "acceptance";
    assert.equal(readV4ComposerDraft(workspace, undefined, "__draft__"), null);
    assert.equal(readComposerRecent(workspace), null);
    persistV4ComposerDraft(workspace, undefined, "__draft__", { text: "profile draft" });
    captureComposerRecentSubmission(workspace, {
      modelSelection: { ...selection, modelId: "profile-model" },
      mode: "build",
    })();
    assert.equal(readV4ComposerDraft(workspace, undefined, "__draft__")?.text, "profile draft");
    runtime.__OMP_ACTIVE_PROFILE__ = "default";
    assert.equal(readV4ComposerDraft(workspace, undefined, "__draft__")?.text, "default draft");
    assert.equal(readComposerRecent(workspace)?.modelSelection?.modelId, "default-model");
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
