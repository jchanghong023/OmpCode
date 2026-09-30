// 子代理只读详情视图 UT：直接驱动 SubagentViewStore，验证事件驱动重水合的行增长、
// 无重复行、终态停表与传输失败容错（G1/G7 修复的局部逻辑）。
// wire 级全链路（真实 adapter 进程 + fake 项目核）见 projectMode.e2e.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { SubagentViewStore } from "../src/app/subagentViews.js";
import { buildOmpSubagentViewId } from "../src/domain/ompProjectFrames.js";
import type { OmpSubagentFrame } from "../src/domain/ompFrames.js";
import type { ConversationEngine } from "../src/app/conversationEngine.js";
import type {
  HostGateway,
  OmpCommandOutcome,
  OmpProjectGatewayPort,
  OmpStorePort,
} from "../src/app/ports.js";
import type { SessionRegistry } from "../src/app/sessionRegistry.js";

const PARENT = "omp-session-parent";
const VIEW_ID = buildOmpSubagentViewId(PARENT, "sa-1");

// 条目带固定时间戳：rowsFromOmpEntries 对缺时间戳条目回退 Date.now()，会让全量重读的
// 确定性重建产生 createdAt 漂移（触发无意义 upsert）；真实 omp 记录携带时间戳。
const T0 = 1_727_500_000_000;

function entryUser(text: string): unknown {
  return {
    type: "message",
    message: { role: "user", timestamp: T0, content: [{ type: "text", text }] },
  };
}

function entryAssistant(text: string, offset = 0): unknown {
  return {
    type: "message",
    message: { role: "assistant", timestamp: T0 + offset, content: [{ type: "text", text }] },
  };
}

function subagentEvent(delta: string): OmpSubagentFrame {
  return {
    type: "subagent_event",
    payload: {
      id: "sa-1",
      event: {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta },
      },
    },
  };
}

interface Harness {
  store: SubagentViewStore;
  engine: ConversationEngine;
  calls(): number;
  rows(): Pick<ConversationRow, "rowId" | "kind" | "text">[];
  deltasSince(fromSeq: number): ConversationDelta[];
  seq(): number;
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

async function createStore(
  responder: (command: unknown) => Promise<OmpCommandOutcome>,
): Promise<Harness> {
  let calls = 0;
  const gateway: HostGateway = {
    emitFrame: () => {},
    requestUserInput: () => {
      throw new Error("not expected in this test");
    },
  };
  const store = new SubagentViewStore({
    registry: {} as unknown as SessionRegistry,
    project: {
      sendProject: (command: unknown) => {
        calls += 1;
        return responder(command);
      },
    } as unknown as OmpProjectGatewayPort,
    store: {
      listSessions: async () => [],
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway,
    workspaceId: "test-workspace",
    workspacePath: process.cwd(),
  });
  const engine = await store.acquire(VIEW_ID);
  assert.ok(engine, "合法 viewId 必须建立视图引擎");
  engine.subscribe({ sessionId: VIEW_ID, connectionId: "ut", clientMode: "desktop-continuous" });
  return {
    store,
    engine,
    calls: () => calls,
    rows: () =>
      [...engine.projection.rowsRange(undefined, 100).rows].map((row) => ({
        rowId: row.rowId,
        kind: row.kind,
        text: (row as { text?: string }).text,
      })),
    deltasSince: (fromSeq: number) =>
      engine.projection.deltasBetween(fromSeq, engine.projection.seq) ?? [],
    seq: () => engine.projection.seq,
  };
}

test("subagent_event 触发重读合并：行实时增长、同内容不重复下发", async () => {
  let record: unknown[] = [entryUser("scan the repo"), entryAssistant("scanned 3 files")];
  const harness = await createStore(async () => ({ success: true, data: { entries: record } }));
  assert.deepEqual(
    harness.rows().map((row) => [row.rowId, row.kind]),
    [
      [1, "userInput"],
      [2, "assistantText"],
    ],
    "首次水合应含 2 行",
  );
  const before = harness.rows();
  // 第二轮运行的记录追加 + 一条 subagent_event：尾随节流首沿立即重读。
  record = [...record, entryAssistant("scanned 4 files in run 2")];
  const seqBefore = harness.seq();
  harness.store.ingestFrame(PARENT, subagentEvent("delta"));
  await waitFor(() => harness.rows().length === 3, "重读合并后行数增长到 3");
  const after = harness.rows();
  assert.equal(after[2]!.kind, "assistantText");
  assert.match(after[2]!.text ?? "", /run 2/, `新行应来自重读记录：${JSON.stringify(after[2])}`);
  assert.deepEqual(after.slice(0, 2), before, "旧行内容不得变化");
  // 不重复：新行恰一次 row.appended；内容未变的旧行不得重发 upsert/append。
  // （合并产生的 delta 经 publisher 30ms flush 窗口进入 delta log，先等下发。）
  await waitFor(() => harness.deltasSince(seqBefore).length > 0, "合并增量进入下发日志");
  const fresh = harness.deltasSince(seqBefore);
  assert.deepEqual(
    fresh.map((delta) => delta.op),
    ["row.appended"],
    `重读只应产生一次 row.appended：${JSON.stringify(fresh)}`,
  );
  assert.equal((fresh[0] as { row: { rowId: number } }).row.rowId, 3);
  // 幂等：记录不再变化时，后续事件触发的重读不产生任何新 delta。
  const callsBefore = harness.calls();
  harness.store.ingestFrame(PARENT, subagentEvent("delta-2"));
  await waitFor(() => harness.calls() > callsBefore, "事件应触发重读（尾沿）");
  await sleep(50);
  assert.equal(harness.seq(), seqBefore + 1, "同内容重读不得产生增量");
});

test("lifecycle 终态后停止重读调度（终态帧补读一次）", async () => {
  const harness = await createStore(async () => ({
    success: true,
    data: { entries: [entryUser("scan the repo"), entryAssistant("scanned 3 files")] },
  }));
  // 先建立重读状态（事件），再终态：finishView 补读收尾并停表。
  harness.store.ingestFrame(PARENT, subagentEvent("delta"));
  await waitFor(() => harness.calls() >= 2, "事件触发重读");
  harness.store.ingestFrame(PARENT, {
    type: "subagent_lifecycle",
    payload: { id: "sa-1", agent: "scout", status: "completed" },
  });
  await waitFor(() => harness.calls() >= 3, "终态补读");
  const callsAtStop = harness.calls();
  // 终态后事件不再触发重读（含尾沿窗口）。
  harness.store.ingestFrame(PARENT, subagentEvent("late"));
  await sleep(1000);
  assert.equal(harness.calls(), callsAtStop, "终态后不得再有重读");
  assert.deepEqual(
    harness.rows().map((row) => row.rowId),
    [1, 2],
  );
});

test("G7：传输层 reject 不使 acquire 失败，视图保持空投影", async () => {
  const harness = await createStore(async () => {
    throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
  });
  assert.deepEqual(harness.rows(), [], "传输失败保持空投影");
});

test("G7：传输失败后事件重读自愈，恢复行对订阅端可见", async () => {
  let fail = true;
  const harness = await createStore(async () => {
    if (fail) throw new Error("timeout");
    return {
      success: true,
      data: { entries: [entryUser("scan the repo"), entryAssistant("scanned 3 files")] },
    };
  });
  assert.deepEqual(harness.rows(), []);
  fail = false;
  harness.store.ingestFrame(PARENT, subagentEvent("delta"));
  await waitFor(() => harness.rows().length === 2, "恢复后重读应水合出 2 行");
  assert.deepEqual(
    harness.rows().map((row) => [row.rowId, row.kind]),
    [
      [1, "userInput"],
      [2, "assistantText"],
    ],
  );
  // 恢复路径必须走 mergeRows（带增量），否则已订阅的空视图永远看不到这些行。
  // （合并产生的 delta 经 publisher 30ms flush 窗口进入 delta log，先等下发。）
  await waitFor(() => harness.deltasSince(0).length > 0, "恢复增量进入下发日志");
  const appended = harness.deltasSince(0).filter((delta) => delta.op === "row.appended");
  assert.deepEqual(
    appended.map((delta) => (delta as { row: { rowId: number } }).row.rowId),
    [1, 2],
    "恢复行应以 row.appended 下发",
  );
});
