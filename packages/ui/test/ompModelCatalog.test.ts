import assert from "node:assert/strict";
import test from "node:test";
import {
  ompSessionConfigToSelection,
  readOmpModelCatalog,
} from "../src/v4/composer/ompModelCatalog.js";

test("新任务优先模型支持的最高思考档，而非当前档或模型默认档", () => {
  const catalog = readOmpModelCatalog([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "mock/mock-1",
      options: [
        {
          value: "mock/mock-1",
          name: "Mock Model",
          modelThoughtLevels: ["off", "low", "high", "max"],
          modelDefaultThoughtLevel: "high",
        },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      type: "select",
      currentValue: "off",
      options: [{ value: "max", name: "max" }],
    },
  ]);
  assert.deepEqual(catalog?.preferredSelection, {
    providerId: "mock",
    modelId: "mock-1",
    options: { reasoningLevel: "max" },
  });
});

test("已有会话从自身投影恢复模型和思考档位", () => {
  assert.deepEqual(
    ompSessionConfigToSelection({ provider: "mock", model: "session-model", thought: "max" }),
    {
      providerId: "mock",
      modelId: "session-model",
      options: { reasoningLevel: "max" },
    },
  );
});
