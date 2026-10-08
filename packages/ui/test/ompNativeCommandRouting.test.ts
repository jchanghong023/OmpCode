import assert from "node:assert/strict";
import test from "node:test";
import { parseV4VisibleSlashCommand } from "../src/v4/slashCommands.js";

const nativeCommands = [
  "wiki",
  "repo",
  "team",
  "plan",
  "loop",
  "goal",
  "advisor",
  "ultrathink",
  "orchestrate",
  "workflowz",
  "fullsend",
  "skill:fixture",
  "compact",
];

test("OMP 核心入口与完整参数不被 GUI 本地 slash 业务消费", () => {
  for (const cliOwnedCommandNames of [new Set(nativeCommands), new Set<string>()]) {
    for (const name of nativeCommands) {
      const text = `  /${name}  first argument\nsecond  line  `;
      assert.equal(parseV4VisibleSlashCommand(text, [], { cliOwnedCommandNames }), null, text);
    }
  }
  for (const text of [
    "/plan",
    "/goal show",
    "/goal pause",
    "/goal resume",
    "/compact preserve notes",
  ]) {
    assert.equal(parseV4VisibleSlashCommand(text, [], { cliOwnedCommandNames: new Set() }), null);
  }
  assert.equal(parseV4VisibleSlashCommand("ultrathink analyze this"), null);
});

test("目录登记的别名和携带上下文的核心命令由 OMP 适配器裁决", () => {
  const cliOwnedCommandNames = new Set(["target", "compress", "extension-command"]);
  for (const text of ["/target pause", "/compress custom summary", "/extension-command args"]) {
    assert.equal(parseV4VisibleSlashCommand(text, [], { cliOwnedCommandNames }), null);
  }
  assert.equal(
    parseV4VisibleSlashCommand("/plan task", [{}], {
      cliOwnedCommandNames: new Set(),
      contextAttachmentCount: 1,
    }),
    null,
  );
});

test("未登记的兼容别名及无目录参数的旧展示解析保留原行为", () => {
  const options = { cliOwnedCommandNames: new Set<string>() };
  assert.deepEqual(parseV4VisibleSlashCommand("/compress", [], options), {
    kind: "compact",
    displayText: "/compress",
  });
  assert.deepEqual(parseV4VisibleSlashCommand("/target resume", [], options), {
    kind: "resumeGoal",
    displayText: "/target resume",
  });
  assert.equal(parseV4VisibleSlashCommand("/goal objective")?.kind, "sendGoalCommand");
  assert.equal(parseV4VisibleSlashCommand("/side question", [], options), null);
  assert.equal(parseV4VisibleSlashCommand("/btw question", [], options), null);
});
