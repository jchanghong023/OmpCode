import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOmpRoleSaveFailure,
  isOmpCapabilityMissingError,
  isOmpRoleOverridden,
  ompRoleEffectiveNote,
  resolveOmpRolesLoadOutcome,
} from "../src/v4/composer/ompModelRolesFallback.js";

// 错误消息取自 omp-agent 三态语义的真实文案（ompProjectMethods.ts / serverApp.ts）：
// -32601 = 旧核永久缺失（unsupported）；-32000 = 项目进程暂时不可用（可重试）。
const CAPABILITY_MISSING = new Error("method not supported by omp core: workspace/ompModelRoles");
const PROCESS_UNAVAILABLE = new Error("omp project process unavailable: workspace/ompModelRoles");

test("回落判定：rpc 未就绪不回落，停留错误态", () => {
  // rpcReady=false（agent 启动中/远端等待）即使有错误也不允许回落直写用户 config.yml。
  assert.equal(resolveOmpRolesLoadOutcome({ rpcReady: false, error: undefined }), "unavailable");
  assert.equal(
    resolveOmpRolesLoadOutcome({ rpcReady: false, error: CAPABILITY_MISSING }),
    "unavailable",
  );
});

test("回落判定：仅 -32601 旧核永久缺失特征回落本地配置", () => {
  assert.equal(
    resolveOmpRolesLoadOutcome({ rpcReady: true, error: CAPABILITY_MISSING }),
    "fallback",
  );
  assert.ok(isOmpCapabilityMissingError(CAPABILITY_MISSING));
  // 非.Error 抛出物（RPC 链路可能透传字符串）同样按消息特征判定。
  assert.ok(
    isOmpCapabilityMissingError("method not supported by omp core: workspace/ompSetModelRole"),
  );
});

test("回落判定：-32000 暂时不可用与其他错误不回落", () => {
  // 项目进程崩溃退避窗（-32000）可恢复：不回落、不绕过 omp 的 role 校验/修订。
  assert.equal(
    resolveOmpRolesLoadOutcome({ rpcReady: true, error: PROCESS_UNAVAILABLE }),
    "unavailable",
  );
  assert.equal(
    resolveOmpRolesLoadOutcome({ rpcReady: true, error: new Error("connection closed") }),
    "unavailable",
  );
  assert.equal(isOmpCapabilityMissingError(PROCESS_UNAVAILABLE), false);
});

test("保存失败分类：仅 -32601 允许转本地回落保存，-32000 保持失败可重试", () => {
  assert.equal(classifyOmpRoleSaveFailure(CAPABILITY_MISSING), "capabilityMissing");
  assert.equal(classifyOmpRoleSaveFailure(PROCESS_UNAVAILABLE), "unavailable");
});

test("被覆盖判定：runtime 是覆盖层，显式用户配置被其覆盖时提示", () => {
  // S8-4：omp rpc-project-models #effectiveNote 把 runtime 列为覆盖层，
  // runtime 覆盖时不得静默显示「已保存」。
  assert.equal(isOmpRoleOverridden({ explicitValue: "example/other", source: "runtime" }), true);
});

test("被覆盖判定：global/default 为生效来源不提示，未知来源按被覆盖处理", () => {
  assert.equal(isOmpRoleOverridden({ explicitValue: "example/other", source: "global" }), false);
  assert.equal(isOmpRoleOverridden({ explicitValue: "example/other", source: "default" }), false);
  // 未知来源（如项目层）fail-visible：提示被覆盖。
  assert.equal(isOmpRoleOverridden({ explicitValue: "example/other", source: "project" }), true);
  // 无显式用户配置或来源未知为空时无「已保存被覆盖」语义。
  assert.equal(isOmpRoleOverridden({ explicitValue: undefined, source: "runtime" }), false);
  assert.equal(isOmpRoleOverridden({ explicitValue: "example/other", source: undefined }), false);
});

test("effectiveNote 透传：保存结果的实际生效说明原样透传，空缺归一为 null", () => {
  assert.equal(
    ompRoleEffectiveNote({ effectiveNote: "overridden by project config (config.toml)" }),
    "overridden by project config (config.toml)",
  );
  assert.equal(ompRoleEffectiveNote({}), null);
  assert.equal(ompRoleEffectiveNote({ effectiveNote: "" }), null);
  assert.equal(ompRoleEffectiveNote(null), null);
  assert.equal(ompRoleEffectiveNote(undefined), null);
});
