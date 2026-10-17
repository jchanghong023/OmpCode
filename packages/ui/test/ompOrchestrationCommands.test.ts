import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOmpOrchestrationCommand,
  getOmpOrchestrationCapabilities,
  type OmpOrchestrationRequest,
} from "../src/v4/native-tools/ompOrchestrationCommands.js";

const loop = {
  command: "loop",
  action: "start",
  kind: "count",
  limit: "10",
  interval: "",
  task: "check status",
} as const;

test("Goal 全部动作生成原生命令，只有 drop 标记删除确认", () => {
  assert.deepEqual(
    buildOmpOrchestrationCommand({
      command: "goal",
      action: "set",
      objective: "  ship safely\nkeep  evidence  ",
    }),
    {
      ok: true,
      text: "/goal set ship safely\nkeep  evidence",
      confirmation: null,
    },
  );
  for (const action of ["show", "pause", "resume", "drop"] as const) {
    assert.deepEqual(buildOmpOrchestrationCommand({ command: "goal", action }), {
      ok: true,
      text: `/goal ${action}`,
      confirmation: action === "drop" ? "drop" : null,
    });
  }
  for (const objective of [undefined, "", " \n "]) {
    assert.deepEqual(buildOmpOrchestrationCommand({ command: "goal", action: "set", objective }), {
      ok: false,
      error: "required",
    });
  }
});

test("Goal budget 使用 RPC 的纯数字安全整数/off 语法", () => {
  for (const [budget, text] of [
    ["1", "1"],
    [" 0010 ", "0010"],
    ["9007199254740991", "9007199254740991"],
    [" OFF ", "off"],
  ]) {
    assert.deepEqual(buildOmpOrchestrationCommand({ command: "goal", action: "budget", budget }), {
      ok: true,
      text: `/goal budget ${text}`,
      confirmation: null,
    });
  }
  for (const budget of [
    undefined,
    "",
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "0x10",
    "Infinity",
    "NaN",
    "9007199254740992",
    "1 2",
    "off\nshow",
  ]) {
    assert.deepEqual(
      buildOmpOrchestrationCommand({ command: "goal", action: "budget", budget }),
      { ok: false, error: "budget" },
      String(budget),
    );
  }
});

test("Loop 裸命令必须确认；启动保留限制、间隔与完整正文", () => {
  assert.deepEqual(buildOmpOrchestrationCommand({ command: "loop", action: "stop" }), {
    ok: true,
    text: "/loop",
    confirmation: "loop",
  });
  assert.deepEqual(buildOmpOrchestrationCommand(loop), {
    ok: true,
    text: "/loop 10 check status",
    confirmation: null,
  });
  assert.deepEqual(
    buildOmpOrchestrationCommand({ ...loop, interval: " 30s ", task: "  check  status\nreport  " }),
    {
      ok: true,
      text: "/loop 10 30s check  status\nreport",
      confirmation: null,
    },
  );
  for (const limit of [
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "9007199254740992",
    "10m",
    "10 minutes",
    "",
  ]) {
    assert.deepEqual(
      buildOmpOrchestrationCommand({ ...loop, limit }),
      { ok: false, error: "count" },
      limit,
    );
  }
  assert.equal(buildOmpOrchestrationCommand({ ...loop, limit: "9007199254740991" }).ok, true);
  assert.deepEqual(buildOmpOrchestrationCommand({ ...loop, task: " \n " }), {
    ok: false,
    error: "required",
  });
});

test("Loop 时长支持原生单位别名、复合和空格形式，不接受小数或零段", () => {
  for (const limit of [
    "1s",
    "30secs",
    "2MIN",
    "10 minutes",
    "1h30m",
    "1hr2mins3seconds",
    "9007199254740991h",
  ]) {
    assert.deepEqual(buildOmpOrchestrationCommand({ ...loop, kind: "duration", limit }), {
      ok: true,
      text: `/loop ${limit} check status`,
      confirmation: null,
    });
  }
  for (const limit of [
    "10",
    "0s",
    "1h0m",
    "1.5h",
    "-1h",
    "+1h",
    "1d",
    "1m 30s",
    "9007199254740992s",
    "10 constructor",
  ]) {
    assert.deepEqual(
      buildOmpOrchestrationCommand({ ...loop, kind: "duration", limit }),
      { ok: false, error: "duration" },
      limit,
    );
  }
});

test("Loop interval 遵守 32-bit timer 毫秒上限和紧凑语法", () => {
  for (const interval of ["1s", "1m30s", "2147483s", "596h"]) {
    assert.deepEqual(buildOmpOrchestrationCommand({ ...loop, interval }), {
      ok: true,
      text: `/loop 10 ${interval} check status`,
      confirmation: null,
    });
  }
  for (const interval of [
    "0s",
    "1h0m",
    "1 seconds",
    "30",
    "1.5s",
    "1d",
    "2147484s",
    "597h",
    "9007199254740991h",
  ]) {
    assert.deepEqual(
      buildOmpOrchestrationCommand({ ...loop, interval }),
      { ok: false, error: "interval" },
      interval,
    );
  }
  // duration 限制并不使用 interval 的 timer 上限。
  assert.equal(buildOmpOrchestrationCommand({ ...loop, kind: "duration", limit: "597h" }).ok, true);
});

test("Loop 正文不能被原生误读为可选间隔、count 单位或条件旗标", () => {
  for (const task of [
    "30s check status",
    "0s check status",
    "1h0m check status",
    "minutes check status",
    "--until 'bun test' fix",
    "--unknown fix",
  ]) {
    assert.deepEqual(
      buildOmpOrchestrationCommand({ ...loop, task }),
      { ok: false, error: "loopTask" },
      task,
    );
  }
  assert.equal(
    buildOmpOrchestrationCommand({ ...loop, interval: "30s", task: "1h of history" }).ok,
    true,
  );
  assert.deepEqual(
    buildOmpOrchestrationCommand({ ...loop, interval: "30s", task: "--while 'true' check" }),
    { ok: false, error: "loopTask" },
  );
  // 未知单位不会被原生的可选 interval parser 吞掉。
  assert.equal(buildOmpOrchestrationCommand({ ...loop, task: "2widgets are failing" }).ok, true);
  assert.equal(buildOmpOrchestrationCommand({ ...loop, task: "constructor checks" }).ok, true);
  assert.equal(
    buildOmpOrchestrationCommand({
      ...loop,
      kind: "duration",
      limit: "10m",
      task: "minutes of history",
    }).ok,
    true,
  );
});

test("Team 与 magic 只接收非空正文，不添加虚构并发或 workflow 参数", () => {
  for (const command of ["team", "orchestrate", "workflowz", "fullsend"] as const) {
    const request: OmpOrchestrationRequest = {
      command,
      task: "  review  requirements\nkeep scope  ",
    };
    assert.deepEqual(buildOmpOrchestrationCommand(request), {
      ok: true,
      text: `/${command} review  requirements\nkeep scope`,
      confirmation: null,
    });
    assert.deepEqual(buildOmpOrchestrationCommand({ command, task: " \n " }), {
      ok: false,
      error: "required",
    });
  }
});

test("可用项必须与真实目录求交，未知命令不伪装成本面板能力", () => {
  assert.deepEqual(
    getOmpOrchestrationCapabilities([
      { name: " /GOAL ", description: "native goal" },
      { name: "team", description: "planning" },
      { name: "team", description: "duplicate" },
      { name: "workflow", description: "not workflowz" },
      { name: "custom", description: "custom" },
    ]),
    {
      available: ["goal", "team"],
      missing: ["loop", "orchestrate", "workflowz", "fullsend"],
    },
  );
  assert.deepEqual(getOmpOrchestrationCapabilities([]), {
    available: [],
    missing: ["goal", "loop", "team", "orchestrate", "workflowz", "fullsend"],
  });
});
