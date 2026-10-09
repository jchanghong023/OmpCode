import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeProcessEnvPatch } from "../src/runtime-tools/runtimeCommandEnv.js";

// Windows 子进程只继承明确允许的工具变量，不能把 NODE_OPTIONS 等进程选项宽继承。

test("Windows 运行时环境保留工具白名单，拒绝 NODE_OPTIONS 和快照外变量", () => {
  const patch = buildRuntimeProcessEnvPatch(
    { PATH: "C:\\Windows\\System32", NODE_OPTIONS: "--inspect", AWS_REGION: "base-only" },
    {
      PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
      AWS_PROFILE: "test-profile",
      NODE_OPTIONS: "--require unsafe-hook",
    },
    { platform: "win32", windowsNodePaths: [] },
  );
  assert.equal(patch.AWS_PROFILE, "test-profile");
  assert.equal(patch.AWS_REGION, undefined);
  assert.equal(patch.NODE_OPTIONS, undefined);
});
