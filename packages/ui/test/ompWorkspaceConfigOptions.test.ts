import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeConfigOption } from "@zcode/shared";
import { mergeOmpWorkspaceConfigOptions } from "../src/lib/ompWorkspaceConfigOptions.js";

const model = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "commandcode/free",
  options: [{ value: "commandcode/free", name: "Free" }],
} as ZCodeConfigOption;
const thought = {
  id: "thought_level",
  name: "Thinking",
  type: "select",
  currentValue: "low",
  options: [{ value: "low", name: "low" }],
} as ZCodeConfigOption;
const mode = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "build",
  options: [{ value: "build", name: "Build" }],
} as ZCodeConfigOption;

test("mode-only 恢复保留先到的 omp 模型目录", () => {
  const merged = mergeOmpWorkspaceConfigOptions([model, thought], [mode]);
  assert.deepEqual(
    merged.map((option) => option.id),
    ["model", "thought_level", "mode"],
  );
  assert.equal(merged[0], model);
  assert.equal(merged[1], thought);
});

test("后到的 workspace-config 模型替换旧目录且保留 mode", () => {
  const newerModel = { ...model, currentValue: "commandcode/new" };
  const merged = mergeOmpWorkspaceConfigOptions([model, mode], [newerModel, thought]);
  assert.deepEqual(
    merged.map((option) => option.id),
    ["model", "thought_level", "mode"],
  );
  assert.equal(merged[0], newerModel);
});
