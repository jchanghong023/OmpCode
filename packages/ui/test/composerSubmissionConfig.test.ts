import { describe, expect, it } from "vitest";
import type { OmpModelCatalog } from "@/omp-configuration/module.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

const view = {
  entries: [
    {
      providerId: "provider-a",
      providerName: "Native Provider",
      modelId: "model-a",
      modelName: "Native Model",
      thoughtLevels: ["low", "high"],
      defaultThoughtLevel: "high",
    },
  ],
  preferredSelection: {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high" },
  },
} satisfies OmpModelCatalog;

describe("createComposerSubmissionConfig", () => {
  it("没有 Composer 草稿时返回空配置而不抛错", () => {
    expect(createComposerSubmissionConfig(undefined, null)).toBeNull();
  });
  it("只从 Composer 复制配置，随后编辑不能改变已提交值", () => {
    const draft = {
      mode: "yolo",
      planEnabled: true,
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      },
    };
    const submission = createComposerSubmissionConfig(draft, view);
    draft.mode = "yolo";
    draft.planEnabled = false;
    draft.modelSelection.options.reasoningLevel = "high";
    expect(submission).toEqual({
      mode: "yolo",
      planEnabled: true,
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      },
    });
    expect(Object.isFrozen(submission?.modelSelection.options)).toBe(true);
  });

  it("空选择和失效档位不创建 Submission，也不使用 preferred", () => {
    for (const modelSelection of [
      undefined,
      { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "removed" } },
      { providerId: "removed", modelId: "model-a", options: { reasoningLevel: "high" } },
    ]) {
      expect(createComposerSubmissionConfig({ mode: "build", modelSelection }, view)).toBeNull();
    }
  });

  it("稀疏 reasoning 不由目录默认值补全", () => {
    const modelSelection = { providerId: "provider-a", modelId: "model-a" };
    expect(
      createComposerSubmissionConfig({ mode: "build", modelSelection }, view)?.modelSelection,
    ).toEqual(modelSelection);
  });

  it("旧平铺展示字段不能补全当前 Selection", () => {
    const draft = { mode: "build", provider: "provider-a", model: "model-a", thought: "high" };
    expect(createComposerSubmissionConfig(draft, view)).toBeNull();
  });

  it("没有 Ready View 或合法模式时不提交", () => {
    const draft = { mode: "build", modelSelection: view.preferredSelection! };
    expect(createComposerSubmissionConfig(draft, null)).toBeNull();
    expect(createComposerSubmissionConfig({ ...draft, mode: "removed" }, view)).toBeNull();
  });
});
