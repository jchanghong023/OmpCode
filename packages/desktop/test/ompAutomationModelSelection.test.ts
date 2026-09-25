import assert from "node:assert/strict";
import test from "node:test";
import { resolveOmpAutomationSubmissionModelSelection } from "../src/host/automationModelSelection.js";

test("Host 派发定时任务时校验 omp 目录，保留已固定 run", async () => {
  const readConfigOptions = async () => [{
    id: "model", name: "Model", type: "select" as const, currentValue: "demo/model-a",
    options: [{ value: "demo/model-a", name: "Model A", modelThoughtLevels: ["off", "high", "max"] }],
  }];
  const selected = { providerId: "demo", modelId: "model-a", options: { reasoningLevel: "high" } };
  assert.deepEqual(await resolveOmpAutomationSubmissionModelSelection({ selection: selected, readConfigOptions }), selected);
  assert.deepEqual(await resolveOmpAutomationSubmissionModelSelection({ readConfigOptions }), {
    providerId: "demo", modelId: "model-a", options: { reasoningLevel: "max" },
  });
  await assert.rejects(
    resolveOmpAutomationSubmissionModelSelection({
      selection: { providerId: "demo", modelId: "missing", options: { reasoningLevel: "high" } },
      readConfigOptions,
    }),
    /omp.*模型/u,
  );
  assert.deepEqual(await resolveOmpAutomationSubmissionModelSelection({ fixedSelection: selected, readConfigOptions }), selected);
});
