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

test("切换 role 模型保留新模型支持的原等级，否则用缺省档位", () => {
  const free = "commandcode/inclusionai/ling-3.0-flash-sante:free";
  // 原等级 high 为新模型支持 → 保留。
  assert.equal(
    selectOmpRoleModelValue(`${free}:high`, "example/other", catalog),
    "example/other:high",
  );
  // 原等级 low 新模型不支持 → 用新模型缺省档位 medium。
  assert.equal(
    selectOmpRoleModelValue(`${free}:low`, "example/other", catalog),
    "example/other:medium",
  );
  // 新模型无缺省档位 → 不写档位后缀。
  const noDefault: OmpModelCatalogEntry[] = [{ ...catalog[1]!, defaultThoughtLevel: undefined }];
  assert.equal(selectOmpRoleModelValue(`${free}:low`, "example/other", noDefault), "example/other");
  assert.equal(selectOmpRoleLevelValue(`${free}:high`, "low", catalog), `${free}:low`);
  assert.equal(selectOmpRoleLevelValue(`${free}:high`, "", catalog), free);
});
