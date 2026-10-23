import { describe, expect, it } from "vitest";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  buildAutomationModelSelectGroups,
  buildAutomationModelSelection,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationPreferredModelValue,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationThoughtLevelUpdate,
} from "@/settings/automationAgentConfigOptions.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { readOmpModelCatalog } from "@/omp-configuration/module.js";

const nativeCatalog = readOmpModelCatalog([
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "demo/model-b",
    options: [
      { value: "demo/model-a", name: "model-a", modelProviderName: "Demo Provider" },
      { value: "demo/model-b", name: "model-b", modelProviderName: "Demo Provider" },
    ],
  },
]);

const groups: ModelSelectGroup[] = [
  {
    key: "provider:demo",
    label: "Demo",
    items: [
      {
        key: "provider:demo:model-a",
        value: encodeCustomModelValue("demo", "model-a"),
        name: "model-a",
      },
      {
        key: "provider:demo:model-b",
        value: encodeCustomModelValue("demo", "model-b"),
        name: "model-b",
      },
    ],
  },
];

describe("automation model/thought linkage", () => {
  it("新建任务固化原生 default role 模型身份", () => {
    expect(resolveAutomationPreferredModelValue(nativeCatalog)).toBe(
      encodeCustomModelValue("demo", "model-b"),
    );
  });

  it("缺少原生目录时不伪造默认模型或候选", () => {
    expect(resolveAutomationPreferredModelValue(null)).toBeNull();
    expect(buildAutomationModelSelectGroups(null)).toEqual([]);
  });

  it("不需要 Host key 或账号配置即可展示原生可用模型", () => {
    expect(
      buildAutomationModelSelectGroups(nativeCatalog).flatMap((group) =>
        group.items.map((item) => item.name),
      ),
    ).toEqual(["model-a", "model-b"]);
  });

  it("使用当前候选档位，但非法旧值留空，不采用 preview 默认值", () => {
    const option = buildAutomationThoughtLevelOption(
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "minimal", name: "Minimal" },
          { value: "high", name: "High" },
        ],
      },
      "medium",
    );

    expect(option?.currentValue).toBe("");
    expect(option?.options?.map((item) => item.value)).toEqual(["minimal", "high"]);
  });

  it("兼容会话内创建任务保存的 provider/model 值", () => {
    expect(resolveAutomationModelItem(groups, "demo/model-a")?.name).toBe("model-a");
  });

  it("模型触发器从原生目录显示 providerName/modelName", () => {
    expect(
      resolveAutomationModelTriggerLabel({
        modelGroups: groups,
        catalog: nativeCatalog,
        modelValue: "demo/model-a",
        fallbackLabel: "选择模型",
      }),
    ).toBe("Demo Provider/model-a");
  });

  it("模型触发器继续遵循会话侧内置 family 的裁剪规则", () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    const modelGroups: ModelSelectGroup[] = [
      {
        key: `provider:${providerId}`,
        label: "BigModel Coding Plan",
        items: [
          {
            key: `provider:${providerId}:glm-5.2`,
            value: encodeCustomModelValue(providerId, "glm-5.2"),
            name: "glm-5.2",
          },
        ],
      },
    ];

    expect(
      resolveAutomationModelTriggerLabel({
        modelGroups,
        modelValue: encodeCustomModelValue(providerId, "glm-5.2"),
        fallbackLabel: "选择模型",
      }),
    ).toBe("glm-5.2");
  });

  it("已保存模型不在当前候选中时仍回显模型名", () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    const staleModel = encodeCustomModelValue(providerId, "glm-5.2");

    expect(
      resolveAutomationModelTriggerLabel({
        modelGroups: [],
        modelValue: staleModel,
        fallbackLabel: "选择模型",
      }),
    ).toBe("glm-5.2");
  });

  it("runtime provider 包装值只在模型名唯一时映射回菜单项", () => {
    expect(resolveAutomationModelItem(groups, "zcode-openai-compatible/model-a")?.value).toBe(
      encodeCustomModelValue("demo", "model-a"),
    );
  });

  it("当前值仍合法时保留用户选择", () => {
    const option = buildAutomationThoughtLevelOption(
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      "high",
    );

    expect(option?.currentValue).toBe("high");
    expect(option?.options?.map((item) => item.value)).toEqual(["low", "medium", "high"]);
  });

  it("没有具体档位时留空，不补最高档", () => {
    const option = buildAutomationThoughtLevelOption(
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      },
      "",
    );

    expect(option?.currentValue).toBe("");
  });

  it.each(["edit", "guarded", "yolo"])(
    "编辑态权限 %s 原样回显，菜单用 guarded 替代 edit",
    (mode) => {
      const option = buildAutomationModeOption(mode);

      expect(option.currentValue).toBe(mode);
      expect(option.options?.map((item) => item.value)).toEqual([
        "build",
        "guarded",
        "plan",
        "yolo",
      ]);
    },
  );

  it("ModelSelection 只保存模型身份与 reasoning，不继承旧输出预算", () => {
    const previous = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "low", maxOutputTokens: 12_000 },
    } as const;
    expect(
      buildAutomationModelSelection({
        selected: { providerId: "provider-a", modelId: "model-a" },
        reasoningLevel: "high",
        previous,
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
    expect(
      buildAutomationModelSelection({
        selected: { providerId: "provider-b", modelId: "model-b" },
        previous,
      }),
    ).toEqual({ providerId: "provider-b", modelId: "model-b" });
  });

  it("编辑切到无 Think 模型时显式清空旧档位", () => {
    expect(
      resolveAutomationThoughtLevelUpdate({
        editing: true,
        explicitlyChanged: false,
        modelChanged: true,
        resolvedThoughtLevel: "",
        thoughtLevel: "max",
      }),
    ).toBeNull();
  });

  it("新建任务的无 Think 模型不写入 thoughtLevel", () => {
    expect(
      resolveAutomationThoughtLevelUpdate({
        editing: false,
        explicitlyChanged: false,
        modelChanged: true,
        resolvedThoughtLevel: "",
        thoughtLevel: "max",
      }),
    ).toBeUndefined();
  });

  it("把目标模型当前档位固化到定时任务", () => {
    expect(
      resolveAutomationThoughtLevelUpdate({
        editing: false,
        explicitlyChanged: false,
        modelChanged: true,
        resolvedThoughtLevel: "high",
        thoughtLevel: "high",
      }),
    ).toBe("high");
  });

  it("用户显式选择与默认相同的档位时仍保存 pin", () => {
    expect(
      resolveAutomationThoughtLevelUpdate({
        editing: false,
        explicitlyChanged: true,
        modelChanged: true,
        resolvedThoughtLevel: "high",
        thoughtLevel: "high",
      }),
    ).toBe("high");
  });

  it("编辑未触碰模型和档位时保留已有显式 pin", () => {
    expect(
      resolveAutomationThoughtLevelUpdate({
        editing: true,
        explicitlyChanged: false,
        modelChanged: false,
        persistedReasoningLevel: "max",
        resolvedThoughtLevel: "max",
        thoughtLevel: "max",
      }),
    ).toBe("max");
  });
});
