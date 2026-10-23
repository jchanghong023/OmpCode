import { describe, expect, it } from "vitest";
import type { OmpModelCatalog } from "@/omp-configuration/module.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
const view = {
  entries: [
    {
      providerId: "account:bigmodel-team-coding-plan",
      providerName: "Native Provider",
      modelId: "glm-5",
      modelName: "Native Model",
      thoughtLevels: ["high"],
      defaultThoughtLevel: "high",
    },
    {
      providerId: "native-free",
      providerName: "Built-in",
      modelId: "free-chat",
      modelName: "Free Chat",
      thoughtLevels: undefined,
      defaultThoughtLevel: undefined,
    },
  ],
  preferredSelection: null,
} satisfies OmpModelCatalog;
const config: SessionConfigState = {
  provider: "account:bigmodel-team-coding-plan",
  model: "glm-5",
  thought: "high",
  thoughtLevels: ["high"],
  mode: "build",
  followupMode: "queue",
  modelSelection: { providerId: "account:bigmodel-individual-coding-plan", modelId: "glm-5" },
};
describe("副屏推荐模型来源", () => {
  it("使用父 runtime 的生效投影与思考，不用旧套餐 ID 或主输入草稿", () => {
    expect(resolveSelectionSideInheritedModel(config, view)).toEqual({
      providerId: config.provider,
      modelId: config.model,
      options: { reasoningLevel: "high" },
    });
    expect(config.modelSelection?.providerId).toBe("account:bigmodel-individual-coding-plan");
  });
  it("缺目录、模型或显式失效思考时跳过推荐，不伪造默认选择", () => {
    expect(resolveSelectionSideInheritedModel(config, null)).toBeNull();
    expect(resolveSelectionSideInheritedModel({ ...config, thought: "invalid" }, view)).toBeNull();
    expect(resolveSelectionSideInheritedModel(null, view)).toBeNull();
  });
  it("原生免 key 无思考模型继承父运行态身份，空档位保持稀疏", () => {
    const runtime = { ...config, provider: "native-free", model: "free-chat", thought: "" };
    expect(resolveSelectionSideInheritedModel(runtime, view)).toEqual({
      providerId: "native-free",
      modelId: "free-chat",
    });
    expect(resolveSelectionSideInheritedModel({ ...runtime, thought: "invalid" }, view)).toBeNull();
  });
});
