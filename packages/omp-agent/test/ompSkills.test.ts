import assert from "node:assert/strict";
import { test } from "node:test";
import { skillCatalogOfCommands } from "../src/domain/ompSkills.js";

test("omp 技能目录仅保留可执行 skill 命令并去重", () => {
  const skills = skillCatalogOfCommands([
    { name: "help", source: "builtin" },
    { name: "skill:agent-browser", source: "skill", description: "Browse" },
    { name: "skill:Agent-Browser", source: "skill" },
    { name: "skill:bad/name", source: "skill" },
    { name: "skill:", source: "skill" },
    { name: "skill:disabled", source: "extension" },
  ]);
  assert.deepEqual(skills, [
    {
      id: "omp:skill:agent-browser",
      name: "agent-browser",
      description: "Browse",
      scope: "omp",
      enabled: true,
    },
  ]);
});
