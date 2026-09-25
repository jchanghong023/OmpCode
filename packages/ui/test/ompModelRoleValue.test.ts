import assert from "node:assert/strict";
import test from "node:test";
import type { OmpModelCatalogEntry } from "../src/v4/composer/ompModelCatalog.js";
import {
  parseOmpRoleValue,
  ompRoleValueToSelection,
  selectOmpRoleLevelValue,
  selectOmpRoleModelValue,
} from "../src/v4/composer/ompModelRoleValue.js";

const catalog: OmpModelCatalogEntry[] = [
  {
    providerId: "commandcode",
    providerName: "CommandCode",
    modelId: "inclusionai/ling-3.0-flash-sante:free",
    modelName: "Ling Flash Free",
    thoughtLevels: ["low", "high", "max"],
    defaultThoughtLevel: "low",
  },
  {
    providerId: "example",
    providerName: "Example",
    modelId: "other",
    modelName: "Other",
    thoughtLevels: ["medium", "high"],
    defaultThoughtLevel: "medium",
  },
];

test("模型 ID 内的冒号与思考档位分别解析", () => {
  const raw = "commandcode/inclusionai/ling-3.0-flash-sante:free";
  assert.deepEqual(parseOmpRoleValue(raw, catalog), { modelPart: raw, levelSuffix: null });
  assert.deepEqual(parseOmpRoleValue(`${raw}:high`, catalog), {
    modelPart: raw,
    levelSuffix: "high",
  });
  assert.deepEqual(ompRoleValueToSelection(`${raw}:max`, catalog), {
    providerId: "commandcode",
    modelId: "inclusionai/ling-3.0-flash-sante:free",
    options: { reasoningLevel: "max" },
  });
  assert.deepEqual(ompRoleValueToSelection(raw, catalog), {
    providerId: "commandcode",
    modelId: "inclusionai/ling-3.0-flash-sante:free",
    options: { reasoningLevel: "max" },
  });
  assert.deepEqual(parseOmpRoleValue("@task:high", catalog), {
    modelPart: "@task:high",
    levelSuffix: null,
  });
});

test("切换 role 模型取新模型支持的最高思考档", () => {
  const free = "commandcode/inclusionai/ling-3.0-flash-sante:free";
  assert.equal(
    selectOmpRoleModelValue(`${free}:high`, "example/other", catalog),
    "example/other:high",
  );
  assert.equal(
    selectOmpRoleModelValue(`${free}:low`, "example/other", catalog),
    "example/other:high",
  );
  assert.equal(selectOmpRoleLevelValue(`${free}:high`, "low", catalog), `${free}:low`);
  assert.equal(selectOmpRoleLevelValue(`${free}:high`, "", catalog), free);
});
