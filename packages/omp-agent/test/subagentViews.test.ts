// 子代理只读详情视图 UT：直接驱动 SubagentViewStore，验证事件驱动重水合的行增长、
// 无重复行、终态停表与传输失败容错（G1/G7 修复的局部逻辑）。
// 读取链 = 父会话引擎的 readSubagentRecord（get_subagent_messages fromByte 续读；
// 2026-10-07 起上游响应无 hasMore/recordTooLarge，以 nextByte 推进为读尽信号）。
// wire 级全链路（真实 adapter 进程 + fake 核）见 adapter.e2e.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { SubagentViewStore, type SubagentViewRegistry } from "../src/app/subagentViews.js";
import { buildOmpSubagentViewId } from "../src/domain/ompFrames.js";
import type { OmpSubagentFrame } from "../src/domain/ompFrames.js";
import type { ConversationEngine } from "../src/app/conversationEngine.js";
import type { HostGateway, OmpCommandOutcome, OmpStorePort } from "../src/app/ports.js";

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
  responder: (command: {
    subagentId?: string;
    fromByte?: number;
  }) => Promise<OmpCommandOutcome | null>,
  persistedStore?: Pick<OmpStorePort, "readSessionEntries" | "readSubagentEntries">,
): Promise<Harness> {
  let calls = 0;
  const gateway: HostGateway = {
    emitFrame: () => {},
    requestUserInput: () => {
      throw new Error("not expected in this test");
    },
  };
  // 父会话引擎替身：只实现视图读取面（subagentProcessHost → get_subagent_messages）。
  const parentEngine = {
    subagentProcessHost: () => ({
      ensureStarted: async () => {},
      currentProcess: () => ({
        send: (command: { type: string; subagentId?: string; fromByte?: number }) => {
          calls += 1;
          assert.equal(command.type, "get_subagent_messages");
          assert.equal(command.subagentId, "sa-1");
          return responder(command);
        },
      }),
    }),
  } as unknown as ConversationEngine;
  Object.defineProperty(parentEngine, "ompSessionFile", { value: "C:/sessions/parent.jsonl" });
  const registry: SubagentViewRegistry = {
    getEngine: (sessionId) => (sessionId === PARENT ? parentEngine : null),
    resumeSession: async () => parentEngine,
  };
  const store = new SubagentViewStore({
    registry,
    gateway,
    workspaceId: "test-workspace",
    workspacePath: process.cwd(),
    store: persistedStore,
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
  // 增量文件模型：已服务条目之后的部分才在后续读取出现（nextByte 固定 4096 表示
  // 「本次响应后暂无更多」，新条目由下一次读取返回——与游标推进终止条件兼容）。
  let served = 0;
  const harness = await createStore(async () => {
    const entries = record.slice(served);
    served = record.length;
    return { success: true, data: { entries, nextByte: 4096 } };
  });
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
  const harness = await createStore(async ({ fromByte }) =>
    fromByte
      ? { success: true, data: { entries: [], nextByte: 4096 } }
      : {
          success: true,
          data: {
            entries: [entryUser("scan the repo"), entryAssistant("scanned 3 files")],
            nextByte: 4096,
          },
        },
  );
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

test("G7：传输层失败（null/失败响应）不使 acquire 失败，视图保持空投影", async () => {
  // 普通传输失败不回退磁盘，不能把当前错误掩盖成旧记录成功。
  const harness = await createStore(async () => null);
  assert.deepEqual(harness.rows(), [], "传输失败保持空投影");
});

test("G7：传输失败后事件重读自愈，恢复行对订阅端可见", async () => {
  let fail = true;
  let served = 0;
  const harness = await createStore(async () => {
    if (fail) throw new Error("timeout");
    const all = [entryUser("scan the repo"), entryAssistant("scanned 3 files")];
    const entries = all.slice(served);
    served = all.length;
    return { success: true, data: { entries, nextByte: 4096 } };
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

// ── C1：上游 get_subagent_messages 的 fromByte/nextByte 续读语义 ──

/** 把固定记录序列化为 JSONL，按窗口切片（只返回窗口内完整记录；nextByte 推进即有后续）。 */
function windowedReader(record: unknown[], windowBytes: number, calls: { fromByte?: number }[]) {
  const buffer = Buffer.from(
    `${record.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return async (command: { fromByte?: number }): Promise<OmpCommandOutcome> => {
    const fromByte =
      typeof command.fromByte === "number" && command.fromByte >= 0 ? command.fromByte : 0;
    calls.push({ fromByte });
    const chunk = buffer.subarray(fromByte, fromByte + windowBytes);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // 无完整记录：游标不动（视图侧据此判定读尽，不再请求）。
      return { success: true, data: { entries: [], nextByte: fromByte } };
    }
    const entries = chunk
      .subarray(0, lastNewline + 1)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const nextByte = fromByte + lastNewline + 1;
    return { success: true, data: { entries, nextByte } };
  };
}

test("C1：多窗续读——fromByte 游标推进，跨窗记录全量可见", async () => {
  const record = [entryUser("scan the repo"), entryAssistant("scanned 3 files")];
  const calls: { fromByte?: number }[] = [];
  // 窗口取「最长行 + 换行」：首窗只装得下第一行，第二行留到下一窗。
  const windowBytes =
    Math.max(...record.map((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8"))) + 1;
  const harness = await createStore(windowedReader(record, windowBytes, calls));
  assert.deepEqual(
    harness.rows().map((row) => [row.kind, row.text]),
    [
      ["userInput", "scan the repo"],
      ["assistantText", "scanned 3 files"],
    ],
    "两窗记录必须全量可见（跨窗拼接）",
  );
  assert.equal(calls.length, 3, "两窗读尽 + 一次空窗确认（nextByte 不再推进即停）");
  assert.equal(calls[0]!.fromByte, 0, "首窗从 0 开始");
  assert.equal(typeof calls[1]!.fromByte, "number");
  assert.ok((calls[1]!.fromByte as number) > 0, `游标推进：${JSON.stringify(calls)}`);
});

test("C1：记录不可用（success:false）——插入「记录不可用」提示行，替换静默空视图", async () => {
  const harness = await createStore(async () => ({
    success: false,
    error: "Subagent transcript unavailable: sa-1",
  }));
  const rows = harness.rows();
  assert.equal(rows.length, 1, "不得静默返回空视图（Z14：缺失内容要有明确提示）");
  assert.match(rows[0]!.text ?? "", /记录不可用/);
});

test("冷恢复 Unknown subagent 仅在父历史证明归属后读持久记录", async () => {
  let reads = 0;
  const persistedStore = {
    readSessionEntries: async () => [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "task-1",
          details: { progress: [{ id: "sa-1", agent: "scout" }] },
        },
      },
    ],
    readSubagentEntries: async () => {
      reads += 1;
      return [entryUser("persisted"), entryAssistant("done")];
    },
  };
  const outcome = { success: false, error: "Unknown subagent or session file unavailable: sa-1" };
  const harness = await createStore(async () => outcome, persistedStore);
  assert.equal(reads, 1);
  assert.deepEqual(
    harness.rows().map((row) => row.text),
    ["persisted", "done"],
  );
  const unowned = await createStore(async () => outcome, {
    ...persistedStore,
    readSessionEntries: async () => [],
  });
  assert.equal(reads, 1, "无父会话归属证明不得读任意子代理路径");
  assert.match(unowned.rows()[0]?.text ?? "", /记录不可用/);
});

// ── S6-4：reset=true 替换语义（transcript 收缩重写，omp reset 游标归零）──

test("S6-4：reset 替换语义——旧行多于新行集时残留陈旧行被清除", async () => {
  let served1 = false;
  let respond: (fromByte?: number) => OmpCommandOutcome = () => {
    if (served1) return { success: true, data: { entries: [], nextByte: 4096 } };
    served1 = true;
    return {
      success: true,
      data: {
        entries: [entryUser("run 1 a"), entryAssistant("run 1 b"), entryAssistant("run 1 c")],
        nextByte: 4096,
      },
    };
  };
  const harness = await createStore(async ({ fromByte }) => respond(fromByte));
  assert.deepEqual(
    harness.rows().map((row) => row.text),
    ["run 1 a", "run 1 b", "run 1 c"],
    "首次水合应含 3 行",
  );
  // transcript 收缩重写：reset=true（游标越界归零），新行集只有 2 行。
  // mergeRows 只增不删——替换语义必须清掉旧累积残留的第 3 行。
  let phase: "reset" | "stable" = "reset";
  respond = (fromByte) =>
    phase === "reset"
      ? {
          // reset：游标越界归零重放（服务端不关心客户端旧游标）。
          success: true,
          data: {
            entries: [entryUser("run 2 a"), entryAssistant("run 2 b")],
            nextByte: 240,
            reset: true,
          },
        }
      : fromByte === undefined || fromByte < 240
        ? {
            success: true,
            data: {
              entries: [entryUser("run 2 a"), entryAssistant("run 2 b")],
              nextByte: 241,
            },
          }
        : { success: true, data: { entries: [], nextByte: fromByte } };
  harness.store.ingestFrame(PARENT, subagentEvent("delta"));
  const seqBefore = harness.seq();
  await waitFor(() => {
    const rebuilt = harness.store.getEngine(VIEW_ID);
    return (
      rebuilt !== null &&
      rebuilt === harness.engine &&
      rebuilt.projection.rowsRange(undefined, 100).rows.length === 2
    );
  }, "reset 后同一订阅引擎应仅含新行集");
  const rebuilt = harness.store.getEngine(VIEW_ID)!;
  assert.deepEqual(
    [...rebuilt.projection.rowsRange(undefined, 100).rows].map(
      (row) => (row as { text?: string }).text,
    ),
    ["run 2 a", "run 2 b"],
    "陈旧行（run 1 b/run 1 c）必须被清除，不得残留",
  );
  assert.equal(rebuilt, harness.engine, "reset 不得丢弃原订阅");
  await waitFor(
    () => harness.deltasSince(seqBefore).some((delta) => delta.op === "row.removed"),
    "删除屏障下发",
  );
  const fresh = harness.deltasSince(seqBefore);
  assert.equal(fresh[0]?.op, "row.removed");
  assert.deepEqual(
    fresh
      .filter((delta) => delta.op === "row.appended")
      .map((delta) => ("row" in delta ? delta.row.rowId : null)),
    [1, 2],
  );
  // 重建后的引擎就是当前视图：后续非 reset 重读继续落在它上，合并行为不变、不再重建。
  phase = "stable";
  const callsBefore = harness.calls();
  harness.store.ingestFrame(PARENT, subagentEvent("delta-2"));
  await waitFor(() => harness.calls() > callsBefore, "重建后事件仍应触发重读");
  await sleep(60);
  assert.equal(harness.store.getEngine(VIEW_ID), rebuilt, "非 reset 重读不得再次重建引擎");
});
