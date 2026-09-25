import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";
import type { OmpModelCatalog } from "../src/v4/composer/ompModelCatalog.js";
import { toggleOmpPlanModel } from "../src/v4/composer/useOmpPlanModelToggle.js";

const catalog: OmpModelCatalog = {
  entries: [
    {
      providerId: "example",
      providerName: "Example",
      modelId: "default",
      modelName: "Default",
      thoughtLevels: ["low", "high"],
      defaultThoughtLevel: "low",
    },
    {
      providerId: "example",
      providerName: "Example",
      modelId: "plan",
      modelName: "Plan",
      thoughtLevels: ["high", "max"],
      defaultThoughtLevel: "high",
    },
  ],
  preferredSelection: null,
};

function createScope() {
  const modelSelection = {
    providerId: "example",
    modelId: "default",
    options: { reasoningLevel: "high" },
  };
  const stateRef: { current: { scopeKey: string; draft: V4ComposerDraft } } = {
    current: {
      scopeKey: "workspace/session",
      draft: { text: "", updatedAt: 0, modelSelection },
    },
  };
  const draftConfigRef = {
    current: { modelSelection } as Partial<SessionConfigState>,
  };
  let writes = 0;
  const updateComposerDraft = (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
    writes++;
    stateRef.current.draft = update(stateRef.current.draft);
    draftConfigRef.current.modelSelection = stateRef.current.draft.modelSelection;
  };
  return {
    stateRef,
    draftConfigRef,
    updateComposerDraft,
    get writes() {
      return writes;
    },
  };
}

test("计划模型切换与退出都写入同一个草稿，并恢复原思考档", async () => {
  const scope = createScope();
  let reads = 0;
  const platform = {
    readOmpModelRoles: async () => {
      reads++;
      return { success: true as const, roles: [{ role: "plan", value: "example/plan:max" }] };
    },
  };
  const params = { scopeKey: "workspace/session", catalog, platform, ...scope };
  assert.deepEqual(await toggleOmpPlanModel(params), { success: true });
  assert.deepEqual(scope.stateRef.current.draft.modelSelection, {
    providerId: "example",
    modelId: "plan",
    options: { reasoningLevel: "max" },
  });
  assert.deepEqual(await toggleOmpPlanModel(params), { success: true });
  assert.equal(scope.stateRef.current.draft.modelSelection?.modelId, "default");
  assert.equal(scope.stateRef.current.draft.modelSelection?.options?.reasoningLevel, "high");
  assert.equal(scope.stateRef.current.draft.planModelReturnSelection, undefined);
  assert.equal(scope.writes, 2);
  assert.equal(reads, 1);
});

test("读取 plan 角色期间会话或模型变化，不覆盖新草稿", async () => {
  for (const changed of ["scope", "selection"] as const) {
    const scope = createScope();
    let resolveRoles:
      | ((value: { success: true; roles: { role: string; value: string }[] }) => void)
      | undefined;
    const platform = {
      readOmpModelRoles: () =>
        new Promise<{ success: true; roles: { role: string; value: string }[] }>((resolve) => {
          resolveRoles = resolve;
        }),
    };
    const pending = toggleOmpPlanModel({
      scopeKey: "workspace/session",
      catalog,
      platform,
      ...scope,
    });
    if (changed === "scope") scope.stateRef.current.scopeKey = "workspace/other";
    else scope.draftConfigRef.current.modelSelection = { providerId: "example", modelId: "plan" };
    resolveRoles?.({ success: true, roles: [{ role: "plan", value: "example/plan:max" }] });
    assert.deepEqual(await pending, { success: false, error: "selection_changed" });
    assert.equal(scope.writes, 0);
  }
});
