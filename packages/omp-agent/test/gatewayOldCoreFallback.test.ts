// 网关与进程适配器分片修复 UT 集合：
//  - B4 真旧核（--rpc-project unknown flag → exit 2）永久回落，二次 ensure 不再 spawn；
//  - S1-1 exit 2 但 stderr 无 unknown flag（omp reportInvalidFlagValues 的非法 flag 值，
//    args.ts:422-428）保持可重试 unavailable，不永久回落；
//  - B3 项目进程 command_catalog_changed / skills_changed 钩子透传与目录刷新推送；
//  - B5 旧拓扑响应错误码（code）透传；
//  - A8 用户输入类命令超时选择（prompt/steer/follow_up/abort_and_prompt 放宽）。
// 真旧核用 fixtures/fakeOmpOldCore.mjs 驱动；其余用 `node -e` 内联 fake 核。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { OmpProjectGateway } from "../src/adapters/ompProjectGateway.js";
import { createOmpProcessFactory, ompCommandTimeoutMs } from "../src/adapters/ompProcess.js";
import { createProjectCatalogRefresh } from "../src/adapters/cliMain.js";

const packageRoot = join(fileURLToPath(import.meta.url), "..", "..");
const oldCoreFixture = join(packageRoot, "test", "fixtures", "fakeOmpOldCore.mjs");
const fakeOmpProjectPath = join(packageRoot, "test", "fixtures", "fakeOmpProject.mjs");

const scratchRoot = mkdtempSync(join(tmpdir(), "omp-gateway-ut-"));
process.on("exit", () => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function markerStarts(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("start")).length;
  } catch {
    return 0;
  }
}

// ── B4：真旧核永久回落 ──

test("B4: 真旧核（--rpc-project unknown flag→exit 2）永久回落：unsupported 语义、二次 ensure 不再 spawn", async () => {
  const runDir = mkdtempSync(join(scratchRoot, "old-core-"));
  const markerPath = join(runDir, "marker.log");
  // 网关在测试进程内直接拉起 fake 旧核：经环境变量传 spawn 计数标记文件。
  const previousMarker = process.env.FAKE_OMP_MARKER;
  process.env.FAKE_OMP_MARKER = markerPath;
  const gateway = new OmpProjectGateway({
    binaryPath: process.execPath,
    extraArgs: [oldCoreFixture],
    cwd: runDir,
    onExit: () => {},
  });
  try {
    assert.equal(await gateway.ensure(), null, "旧核必须回落（返回 null）");
    // -32601 语义（unsupported）：区别于启动失败 unavailable（-32000 可重试）。
    assert.equal(await gateway.availability(), "unsupported");
    assert.equal(markerStarts(markerPath), 1);
    // 永久回落：再次 ensure / 项目方法不得重新 spawn 必败进程。
    assert.equal(await gateway.ensure(), null);
    const outcome = await gateway.listSessions();
    assert.equal(outcome.success, false);
    assert.equal(markerStarts(markerPath), 1, "永久回落后不得再 spawn 旧核进程");
  } finally {
    await gateway.dispose();
    if (previousMarker === undefined) {
      delete process.env.FAKE_OMP_MARKER;
    } else {
      process.env.FAKE_OMP_MARKER = previousMarker;
    }
  }
});

test("B4: 普通启动失败（exit 1、无 unknown flag）保持可重试语义（unavailable），不永久回落", async () => {
  const runDir = mkdtempSync(join(scratchRoot, "generic-fail-"));
  const gateway = new OmpProjectGateway({
    binaryPath: process.execPath,
    // 「--」把适配器追加的 --mode/--rpc-project 隔离为脚本 argv（node -e 的选项解析边界）。
    extraArgs: ["-e", "process.exit(1);", "--"],
    cwd: runDir,
    onExit: () => {},
  });
  try {
    assert.equal(await gateway.ensure(), null);
    assert.equal(await gateway.availability(), "unavailable", "非旧核失败必须保持可重试三态");
    // 退避窗口内不再 spawn。
    assert.equal(await gateway.ensure(), null);
  } finally {
    await gateway.dispose();
  }
});

// 修复（S1-1）：omp 侧 reportUnrecognizedFlags（unknown flag）与 reportInvalidFlagValues
// （非法 flag 值）都走 process.exit(2)（main.ts:2509-2513），但后者 stderr 文案是
// `Error: <message>` 不含 "unknown flag"（args.ts:422-428）。exit 2 不再单独充分判定
// 旧核——非法值必须走普通启动失败路径（可重试 unavailable），否则会被误判旧核永久回落。
test("S1-1: exit 2 但 stderr 无 unknown flag（非法 flag 值）保持可重试 unavailable，不永久回落", async () => {
  const runDir = mkdtempSync(join(scratchRoot, "invalid-flag-value-"));
  const previousMode = process.env.FAKE_OMP_FAILURE_MODE;
  process.env.FAKE_OMP_FAILURE_MODE = "invalid-flag-value";
  const gateway = new OmpProjectGateway({
    binaryPath: process.execPath,
    extraArgs: [oldCoreFixture],
    cwd: runDir,
    onExit: () => {},
  });
  try {
    assert.equal(await gateway.ensure(), null, "启动失败返回 null（不冒充可用）");
    assert.equal(
      await gateway.availability(),
      "unavailable",
      "exit 2 无 unknown flag 文案必须保持可重试三态，不得判旧核",
    );
    // 退避窗口内不再 spawn；窗口语义与普通启动失败一致（可重试，非永久）。
    assert.equal(await gateway.ensure(), null);
  } finally {
    await gateway.dispose();
    if (previousMode === undefined) {
      delete process.env.FAKE_OMP_FAILURE_MODE;
    } else {
      process.env.FAKE_OMP_FAILURE_MODE = previousMode;
    }
  }
});

// ── B3：项目进程目录/技能事件钩子透传与刷新推送 ──

test("B3: 网关把 command_catalog_changed / skills_changed 透传给进程级钩子", async () => {
  const runDir = mkdtempSync(join(scratchRoot, "hooks-"));
  const events: string[] = [];
  const gateway = new OmpProjectGateway({
    binaryPath: process.execPath,
    extraArgs: [fakeOmpProjectPath],
    cwd: runDir,
    onCatalogChanged: () => events.push("catalog"),
    onSkillsChanged: (scope) => events.push(`skills:${scope ?? ""}`),
    onExit: () => {},
  });
  try {
    const proc = await gateway.ensure();
    assert.ok(proc, "fake 项目核必须可用");
    proc.dispatchFrame({ type: "command_catalog_changed" });
    proc.dispatchFrame({ type: "skills_changed", scope: "user" });
    assert.deepEqual(events, ["catalog", "skills:user"]);
  } finally {
    await gateway.dispose();
  }
});

test("B3: 目录刷新推送：重读目录经 updateSlashCommands 推送并失效缓存；失败/异常载荷保持缓存", async () => {
  const pushed: unknown[] = [];
  let invalidated = 0;
  let failNext = false;
  let payload: unknown = [
    { name: "help", source: "builtin" },
    { name: "ship", source: "extension" },
  ];
  const refresh = createProjectCatalogRefresh({
    loadSkillCommands: async () => {
      if (failNext) throw new Error("omp project process unavailable");
      return payload;
    },
    getApp: () => ({
      updateSlashCommands: (raw) => pushed.push(raw),
      invalidateWorkspaceConfigCache: () => {
        invalidated += 1;
      },
    }),
  });

  refresh();
  await sleep(30);
  assert.deepEqual(pushed, [
    [
      { name: "help", source: "builtin" },
      { name: "ship", source: "extension" },
    ],
  ]);
  assert.equal(invalidated, 1, "推送后失效缓存令 configOptions 下次查询重建");

  // 进程暂不可用：保持缓存不推送。
  failNext = true;
  pushed.length = 0;
  invalidated = 0;
  refresh();
  await sleep(30);
  assert.deepEqual(pushed, [], "失败不得推送");
  assert.equal(invalidated, 0, "失败不得失效缓存");

  // 载荷异常（非数组）：不得把 `/` 面板清空。
  failNext = false;
  payload = undefined;
  refresh();
  await sleep(30);
  assert.deepEqual(pushed, [], "非数组载荷不得推送空目录");
  assert.equal(invalidated, 0);
});

test("B3: 变化风暴 in-flight 去重：在途事件合并为完成后补一轮，不并发加载", async () => {
  let loads = 0;
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pushed: unknown[] = [];
  const refresh = createProjectCatalogRefresh({
    loadSkillCommands: async () => {
      active += 1;
      peak = Math.max(peak, active);
      loads += 1;
      await gate;
      active -= 1;
      return [{ name: "help", source: "builtin" }];
    },
    getApp: () => ({
      updateSlashCommands: (raw) => pushed.push(raw),
      invalidateWorkspaceConfigCache: () => {},
    }),
  });

  refresh();
  refresh();
  refresh();
  await sleep(20);
  assert.equal(loads, 1, "在途刷新期间的新事件必须去重");
  release();
  await sleep(20);
  assert.equal(loads, 2, "风暴合并为完成后恰补一轮");
  assert.equal(peak, 1, "不得并发加载");
  assert.equal(pushed.length, 2);
});

// ── B5：旧拓扑响应错误码透传 ──

// 内联 fake 单会话核：普通命令响应带顶层 code，验证 ompProcess.settleCommand 透传。
const FAKE_CODE_CORE = `
const { createInterface } = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription") {
    process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "boom", code: "omp_command_failed" }) + "\\n");
});
`;

test("B5: 旧拓扑 response 帧的顶层 code 透传到 outcome.code", async () => {
  const omp = createOmpProcessFactory(process.execPath, ["-e", FAKE_CODE_CORE, "--"]).create({
    cwd: scratchRoot,
    onEvent() {},
    onUiRequest() {},
    onExit() {},
  });
  try {
    await omp.start();
    const outcome = await omp.send({ type: "compact" });
    assert.equal(outcome.success, false);
    assert.equal(outcome.error, "boom");
    assert.equal(outcome.code, "omp_command_failed", "code 必须透传（对齐项目模式 G4）");
  } finally {
    await omp.dispose();
  }
});

// ── A8：用户输入类命令超时选择 ──

test("A8: prompt/steer/follow_up/abort_and_prompt 放宽到 600s，其余维持 120s", () => {
  for (const type of ["prompt", "steer", "follow_up", "abort_and_prompt"]) {
    assert.equal(
      ompCommandTimeoutMs({ type }),
      600_000,
      `${type} 必须放宽（admission 前有意挂起）`,
    );
  }
  for (const type of ["abort", "get_state", "compact", "negotiate_protocol"]) {
    assert.equal(ompCommandTimeoutMs({ type }), 120_000, `${type} 维持默认超时`);
  }
  assert.equal(ompCommandTimeoutMs({}), 120_000, "缺 type 维持默认");
  assert.equal(ompCommandTimeoutMs({ type: undefined }), 120_000);
});
