// cliMain 的 Windows omp 启动参数契约：RPC 开发参数与环境变量互相独立。
// offline 与 GUI profile 环境不应额外生成已移除的启动参数。
process.env.OMP_AGENT_NO_AUTO_START = "1";
const { buildOmpExtraArgs } = await import("../src/adapters/cliMain.js");

import assert from "node:assert/strict";
import { test } from "node:test";

test("Windows 启动只透传 OMP_RPC_ARGS_JSON 开发参数", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMP_RPC_ARGS_JSON: '["--config","x.json"]' }), [
    "--config",
    "x.json",
  ]);
  assert.deepEqual(buildOmpExtraArgs({}), []);
});

test("OMP_RPC_ARGS_JSON 非法或非数组时被丢弃，不阻断启动", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMP_RPC_ARGS_JSON: "not-json" }), []);
  assert.deepEqual(buildOmpExtraArgs({ OMP_RPC_ARGS_JSON: '{"a":1}' }), []);
  assert.deepEqual(buildOmpExtraArgs({ OMP_RPC_ARGS_JSON: '["ok",42]' }), ["ok"]);
  assert.deepEqual(buildOmpExtraArgs({ OMP_RPC_ARGS_JSON: "   " }), []);
});

test("OMP_OFFLINE 直接随环境透传，不转成已移除的 --offline 参数", () => {
  for (const OMP_OFFLINE of ["1", "true", "0", ""]) {
    assert.deepEqual(buildOmpExtraArgs({ OMP_OFFLINE }), []);
  }
});

test("未设置启动器 profile 时不透传 --profile（GUI 历史选择由 omp 自身 env 生效）", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMP_PROFILE: "work" }), []);
  assert.deepEqual(buildOmpExtraArgs({ PI_PROFILE: "work" }), []);
});
