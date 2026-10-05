// 子代理域状态映射 UT（R1③ durable 终态映射 + S6-5 可用性复评）：
// 1) 目录面 ompProjectDirectory.projectStatusToDirectory：parked→success、interrupted→cancelled、
//    未知非 live 词→lost（终态），经导出入口 projectSubagentDirectory 驱动；
// 2) 卡片面 OmpSubagentBridge.subagentStatus：live 词白名单→running，durable/未知词收敛到终态
//    （frames schema 正在放宽为 string，bridge 映射是未知词的运行时活防线，测试直接以
//    schema 外状态词驱动）；
// 3) S6-5：refresh 一次瞬时失败→unavailable 不再钉死到进程重启，后续子代理帧触发复评翻回
//    ready；终态后晚到的 running 快照不得复活已结束行（复评引入更多 refresh 的配套守卫）。
// wire 级全链路见 projectMode.e2e.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { projectSubagentDirectory } from "../src/app/ompProjectDirectory.js";
import { OmpSubagentBridge } from "../src/app/ompSubagentBridge.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import type { OmpSubagentFrame } from "../src/domain/ompFrames.js";
import type {
  OmpCommandOutcome,
  OmpProjectGatewayPort,
  OmpSessionProcess,
} from "../src/app/ports.js";

// ── 1) 目录面映射（修复1：parked→success、interrupted→cancelled，未知词→lost）──

test("projectStatusToDirectory：parked→success、interrupted→cancelled、未知词收敛到终态 lost", async () => {
  const items = [
    { subagentId: "sa-parked", name: "scout", status: "parked" },
    { subagentId: "sa-interrupted", name: "scout", status: "interrupted" },
    { subagentId: "sa-mystery", name: "scout", status: "some-future-word" },
    { subagentId: "sa-missing", name: "scout" },
    { subagentId: "sa-completed", name: "scout", status: "completed" },
    { subagentId: "sa-failed", name: "scout", status: "failed" },
    { subagentId: "sa-aborted", name: "scout", status: "aborted" },
  ];
  const deps = {
    project: {
      sendProject: async () => ({ success: true, data: { items } }),
    } as unknown as OmpProjectGatewayPort,
    projectAvailable: async () => true,
    projectionDirectory: () => null,
  };
  const directory = await projectSubagentDirectory(deps, "omp-session-parent", 0, 20);
  assert.ok(directory, "项目可用时必须返回目录");
  const ended = (directory as { ended: { items: { agentId: string; status: string }[] } }).ended;
  assert.deepEqual(
    ended.items.map((item) => [item.agentId, item.status]),
    [
      // parked=已完成驻留、可 send_message 唤醒（PARKED_ACTIONS），不得误标 lost。
      ["sa-parked", "success"],
      // interrupted=崩溃中断、无完成事实，与通道侧词汇一致按 cancelled。
      ["sa-interrupted", "cancelled"],
      // 一切未知非 live 词收敛到终态，绝不误标 running/复活。
      ["sa-mystery", "lost"],
      ["sa-missing", "lost"],
      ["sa-completed", "success"],
      ["sa-failed", "failed"],
      ["sa-aborted", "cancelled"],
    ],
  );
});

// ── 2) 卡片面映射（修复3：live 词白名单，未知词收敛终态）──

/** 真实核 schema 外的状态词经运行时到达 bridge（frames 放宽为 string 后合法）；显式 cast。 */
function lifecycleFrame(id: string, status: string): OmpSubagentFrame {
  return {
    type: "subagent_lifecycle",
    payload: { id, agent: "scout", status },
  } as unknown as OmpSubagentFrame;
}

function bridgeOver(projection: ConversationProjection): OmpSubagentBridge {
  return new OmpSubagentBridge(
    projection,
    () => null,
    () => {},
  );
}

function directoryOf(projection: ConversationProjection) {
  return projection.subagentDirectory(0) as {
    running: { status: string }[];
    ended: { items: { status: string }[] };
  };
}

test("subagentStatus：live 词→running，durable 终态与未知词收敛到终态", () => {
  const cases: [word: string, expected: "running" | "success" | "failed" | "cancelled"][] = [
    ["started", "running"],
    ["pending", "running"],
    ["running", "running"],
    ["active", "running"],
    ["completed", "success"],
    ["success", "success"],
    // parked=已完成驻留、可 send_message 唤醒（R1③），与通道侧一致按 success。
    ["parked", "success"],
    ["failed", "failed"],
    ["error", "failed"],
    ["aborted", "cancelled"],
    ["cancelled", "cancelled"],
    // interrupted=崩溃中断、无完成事实，与通道侧一致按 cancelled。
    ["interrupted", "cancelled"],
    // 未来 omp 新增词：宁收敛到终态，绝不误标 running（永挂运行卡片）。
    ["some-future-word", "cancelled"],
  ];
  for (const [word, expected] of cases) {
    const projection = new ConversationProjection("omp-session-status-map");
    projection.beginUserTurn({
      text: "t",
      inputId: "t",
      sourceCommandId: "t",
      clientId: "ut",
    });
    bridgeOver(projection).handle(lifecycleFrame(`sa-${word}`, word));
    const directory = directoryOf(projection);
    if (expected === "running") {
      assert.equal(directory.running.length, 1, `live 词 ${word} 应保持 running`);
      assert.equal(directory.ended.items.length, 0, `live 词 ${word} 不得进 ended 目录`);
    } else {
      assert.deepEqual(
        directory.ended.items.map((item) => item.status),
        [expected],
        `状态词 ${word} 应映射为 ${expected}`,
      );
    }
  }
});

// ── 3) S6-5：可用性一次失败不钉死，帧触发复评 ──

function fakeProcess(send: (command: unknown) => Promise<OmpCommandOutcome>): OmpSessionProcess {
  return {
    ompSessionFile: null,
    projectMode: false,
    start: async () => {},
    send,
    respondUi: () => {},
    refreshState: async () => null,
    readContextReport: async () => null,
    dispose: async () => {},
  } as unknown as OmpSessionProcess;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`等待超时：${what}`);
    }
    await sleep(25);
  }
}

test("S6-5：refresh 一次失败置 unavailable，后续子代理帧触发复评翻回 ready", async () => {
  let fail = true;
  let directorySends = 0;
  const process = fakeProcess(async (command) => {
    if ((command as { type?: string }).type !== "get_subagents") {
      return { success: true, data: {} };
    }
    directorySends += 1;
    return fail
      ? { success: false, error: "transient boom" }
      : { success: true, data: { subagents: [] } };
  });
  const projection = new ConversationProjection("omp-session-s65");
  const bridge = new OmpSubagentBridge(
    projection,
    () => process,
    () => {},
  );
  await bridge.refresh(process);
  assert.equal(
    projection.stateSnapshot.subagents.availability,
    "unavailable",
    "refresh 失败应置 unavailable",
  );
  // 可用性不得一次失败钉死：后续任一子代理帧（lifecycle/progress）补一次 refresh 复评。
  fail = false;
  bridge.handle(lifecycleFrame("sa-1", "started"));
  await waitFor(
    () => projection.stateSnapshot.subagents.availability === "ready",
    "子代理帧应触发复评翻回 ready",
  );
  assert.ok(directorySends >= 2, `复评应补发 get_subagents（实际 ${directorySends} 次）`);
});

test("S6-5 配套守卫：终态后晚到的 running 快照不得复活已结束行", async () => {
  const snapshot = { id: "sa-1", agent: "scout", status: "running" };
  const process = fakeProcess(async (command) => {
    if ((command as { type?: string }).type !== "get_subagents") {
      return { success: true, data: {} };
    }
    return { success: true, data: { subagents: [snapshot] } };
  });
  const projection = new ConversationProjection("omp-session-s65-guard");
  projection.beginUserTurn({ text: "t", inputId: "t", sourceCommandId: "t", clientId: "ut" });
  const bridge = new OmpSubagentBridge(
    projection,
    () => process,
    () => {},
  );
  bridge.handle(lifecycleFrame("sa-1", "completed"));
  assert.deepEqual(
    directoryOf(projection).ended.items.map((item) => item.status),
    ["success"],
    "lifecycle 终态先落为 success",
  );
  await bridge.refresh(process);
  assert.deepEqual(
    directoryOf(projection).ended.items.map((item) => item.status),
    ["success"],
    "晚到的 running 快照不得把已结束子代理拉回 running",
  );
});

// ── 4) schema 放宽锁定：未知状态词的 lifecycle 整帧必须仍可解析（此前封闭枚举会丢整帧、
// 目录状态滞留上一态；放宽后未知词由 bridge 收敛终态）──

test("ompSubagentFrameSchema：未知 lifecycle 状态词不再拒绝整帧", async () => {
  const { ompSubagentFrameSchema } = await import("../src/domain/ompFrames.js");
  const parsed = ompSubagentFrameSchema.safeParse({
    type: "subagent_lifecycle",
    payload: { id: "sa-x", agent: "scout", status: "some-future-word" },
  });
  assert.equal(parsed.success, true);
});
