import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeOmpModelRolesResult } from "@zcode/shared";
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
  const agentService = {
    getOmpModelRoles: async () => {
      reads++;
      return {
        roles: [{
          roleId: "plan",
          effectiveModel: { provider: "example", modelId: "plan", thinkingLevel: "max" },
        }],
      };
    },
  };
  const params = {
    workspacePath: "/workspace",
    scopeKey: "workspace/session",
    catalog,
    platform: null,
    agentService,
    rpcReady: true,
    isRemoteTarget: false,
    ...scope,
  };
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
    let resolveRoles: ((value: ZCodeOmpModelRolesResult) => void) | undefined;
    const agentService = {
      getOmpModelRoles: () =>
        new Promise<ZCodeOmpModelRolesResult>((resolve) => {
          resolveRoles = resolve;
        }),
    };
    const pending = toggleOmpPlanModel({
      scopeKey: "workspace/session",
      catalog,
      workspacePath: "/workspace",
      platform: null,
      agentService,
      rpcReady: true,
      isRemoteTarget: false,
      ...scope,
    });
    if (changed === "scope") scope.stateRef.current.scopeKey = "workspace/other";
    else scope.draftConfigRef.current.modelSelection = { providerId: "example", modelId: "plan" };
    resolveRoles?.({
      roles: [{
        roleId: "plan",
        effectiveModel: { provider: "example", modelId: "plan", thinkingLevel: "max" },
      }],
    });
    assert.deepEqual(await pending, { success: false, error: "selection_changed" });
    assert.equal(scope.writes, 0);
  }
});

test("远端或暂时不可用的角色目录不得读取本机 plan；仅本地旧核缺能力回落", async () => {
  for (const [isRemoteTarget, message, allowFallback] of [
    [true, "method not supported by omp core: workspace/ompModelRoles", false],
    [false, "omp project process unavailable: workspace/ompModelRoles", false],
    [false, "method not supported by omp core: workspace/ompModelRoles", true],
  ] as const) {
    const scope = createScope();
    let localReads = 0;
    const result = await toggleOmpPlanModel({
      workspacePath: "/workspace",
      scopeKey: "workspace/session",
      catalog,
      rpcReady: true,
      isRemoteTarget,
      agentService: { getOmpModelRoles: async () => { throw new Error(message); } },
      platform: {
        readOmpModelRoles: async () => {
          localReads++;
          return { success: true, roles: [{ role: "plan", value: "example/plan:max" }] };
        },
      },
      ...scope,
    });
    assert.equal(result.success, allowFallback);
    assert.equal(localReads, allowFallback ? 1 : 0);
    assert.equal(scope.writes, allowFallback ? 1 : 0);
  }
});
