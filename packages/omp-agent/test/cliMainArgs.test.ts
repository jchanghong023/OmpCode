// cliMain 的 omp 启动参数装配矩阵：CentOS 7 --offline/--profile 透传（分支 94c53d4）
// 与 OMP_RPC_ARGS_JSON 开发参数的叠加顺序保持合并后行为不变。
process.env.OMP_AGENT_NO_AUTO_START = "1";
const { buildOmpExtraArgs } = await import("../src/adapters/cliMain.js");

import assert from "node:assert/strict";
import { test } from "node:test";

test("无 CentOS 7 参数时只透传 OMP_RPC_ARGS_JSON", () => {
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

test("OMPCODE_CENTOS7_OFFLINE=1 透传 --offline，其余取值不透传", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_OFFLINE: "1" }), ["--offline"]);
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_OFFLINE: "0" }), []);
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_OFFLINE: "" }), []);
});

test("启动器设置 OMPCODE_CENTOS7_PROFILE 时按 OMP_PROFILE/PI_PROFILE 解析并透传 --profile", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_PROFILE: "work", OMP_PROFILE: "work" }), [
    "--profile",
    "work",
  ]);
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_PROFILE: "work", PI_PROFILE: "work" }), [
    "--profile",
    "work",
  ]);
});

test("未设置启动器 profile 时不透传 --profile（GUI 历史选择由 omp 自身 env 生效）", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMP_PROFILE: "work" }), []);
  assert.deepEqual(buildOmpExtraArgs({ PI_PROFILE: "work" }), []);
});

test("offline 与 profile 参数固定排在开发参数之后", () => {
  assert.deepEqual(
    buildOmpExtraArgs({
      OMP_RPC_ARGS_JSON: '["--dev"]',
      OMPCODE_CENTOS7_OFFLINE: "1",
      OMPCODE_CENTOS7_PROFILE: "work",
      OMP_PROFILE: "work",
    }),
    ["--dev", "--offline", "--profile", "work"],
  );
});

test("OMPCODE_CENTOS7_PROFILE 已设但 OMP_PROFILE/PI_PROFILE 缺失时按 default 解析（desktop main 须先复制 env）", () => {
  assert.deepEqual(buildOmpExtraArgs({ OMPCODE_CENTOS7_PROFILE: "work" }), [
    "--profile",
    "default",
  ]);
});
