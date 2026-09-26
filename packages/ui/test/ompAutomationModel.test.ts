import assert from "node:assert/strict";
import test from "node:test";
import { readOmpModelCatalog } from "../src/v4/composer/ompModelCatalog.js";
import { resolveOmpAutomationSelection } from "../src/settings/automationAgentConfigOptions.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";

test("定时任务使用 omp 目录中的模型和思考档", () => {
  const catalog = readOmpModelCatalog([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "demo/model-a",
      options: [
        { value: "demo/model-a", name: "Model A", modelThoughtLevels: ["off", "high", "max"] },
      ],
    },
  ]);
  assert.ok(catalog);
  assert.deepEqual(resolveOmpAutomationSelection(catalog, "", ""), {
    providerId: "demo",
    modelId: "model-a",
    options: { reasoningLevel: "max" },
  });
  assert.deepEqual(
    resolveOmpAutomationSelection(catalog, encodeCustomModelValue("demo", "model-a"), "high"),
    {
      providerId: "demo",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    },
  );
  assert.equal(resolveOmpAutomationSelection(catalog, "demo/model-a", "low"), null);
  assert.equal(resolveOmpAutomationSelection(catalog, "demo/missing", "max"), null);
});
