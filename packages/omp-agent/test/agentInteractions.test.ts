import assert from "node:assert/strict";
import { test } from "node:test";
import { zcodeSessionAgentInteractionsResultSchema } from "@zcode/shared";
import { OmpAgentInteractionStore } from "../src/app/OmpAgentInteractionStore.js";
import { OmpAgentInteractionLog } from "../src/domain/OmpAgentInteractionLog.js";
import type { ConversationEngine } from "../src/app/conversationEngine.js";
import type { OmpStorePort } from "../src/app/ports.js";
import { OmpSubagentBridge } from "../src/app/ompSubagentBridge.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import type { OmpSessionProcess } from "../src/app/ports.js";

const T = 1_800_000_000_000;
const call = (id: string, name: string, args: unknown, timestamp = T) => ({
  type: "message",
  message: {
    role: "assistant",
    timestamp,
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});
const result = (id: string, name: string, details: unknown, timestamp = T + 20) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    timestamp,
    details,
  },
});
const incoming = (id: string, from: string, body: string, timestamp = T + 10) => ({
  type: "message",
  message: {
    role: "custom",
    customType: "irc:incoming",
    display: true,
    timestamp,
    details: { id, from, message: body },
    content: "wrapped",
  },
});
function harness(records: Record<string, unknown[]> = {}) {
  let version = 1;
  let reads = 0;
  const versions = new Map<string, string>();
  const store = new OmpAgentInteractionStore({
    readInteractionEntries: async (_path, ancestry, priorVersion) => {
      const key = ancestry.join("/");
      const fileVersion = `${version}:${key}`;
      versions.set(key, fileVersion);
      reads += 1;
      return {
        version: fileVersion,
        available: key in records,
        ...(priorVersion === fileVersion ? {} : { entries: records[key] ?? [] }),
      };
    },
  } as OmpStorePort);
  const engine = {
    sessionId: "root-session",
    ompSessionFile: "C:/sessions/root.jsonl",
    agentInteractions: new OmpAgentInteractionLog(),
  } as ConversationEngine;
  return {
    engine,
    records,
    store,
    reads: () => reads,
    change: () => {
      version += 1;
    },
    query: (cursor?: string, limit = 200) => store.query(engine, cursor, limit, () => true),
  };
}
const spawn = (id: string, agent = "child", task = "assignment") =>
  result(id, "task", {
    progress: [{ id: agent, agent: "task", assignment: task, status: "running" }],
  });

test("成功回执的真实消息 ID 与冷接收记录幂等，同正文不同 ID 不合并", async () => {
  const received = (id: string) => ({
    type: "custom_message",
    id: `record-${id}`,
    timestamp: T + 1000,
    customType: "irc:incoming",
    display: true,
    details: { id, from: "child", message: "same body" },
    content: "wrapped",
  });
  const h = harness({
    "": [spawn("spawn"), received("actual-1"), received("actual-2")],
    child: [
      call("send-1", "write", { path: "agent://Main", content: "same body" }),
      result("send-1", "write", {
        message: {
          op: "send",
          from: "child",
          to: "Main",
          receipts: [{ to: "Main", outcome: "injected", id: "actual-1", ts: T + 10 }],
        },
      }),
      call("send-2", "write", { path: "agent://Main", content: "same body" }, T + 50),
      result(
        "send-2",
        "write",
        {
          message: {
            op: "send",
            from: "child",
            to: "Main",
            receipts: [{ to: "Main", outcome: "injected", id: "actual-2", ts: T + 60 }],
          },
        },
        T + 70,
      ),
    ],
  });
  const snapshot = await h.query();
  const messages = snapshot.events.filter((event) => event.kind === "message");
  assert.deepEqual(
    messages.map((event) => event.messageId),
    ["actual-1", "actual-2"],
  );
  assert.deepEqual(
    messages.map((event) => [
      event.fromAgentId,
      event.toAgentId,
      event.timestamp,
      event.timeBasis,
      event.delivery,
    ]),
    [
      ["child", "main", T + 10, "sent", "injected"],
      ["child", "main", T + 60, "sent", "injected"],
    ],
  );
});

test("后台交付结果 live/history 幂等，节点由同一子记录终态核对，原文及方向保留", async () => {
  const body =
    '<system-notice>\nBackground job Alpha has completed. Resume your work using the result below.\n{"result":"done"}\n</system-notice>';
  const custom = {
    role: "custom",
    customType: "async-result",
    display: true,
    content: body,
    details: { jobs: [{ jobId: "Alpha", type: "task", durationMs: 20 }] },
    timestamp: T + 30,
  };
  const h = harness({
    "": [
      spawn("spawn", "Alpha"),
      { type: "custom_message", id: "entry", ...custom, timestamp: new Date(T + 30).toISOString() },
    ],
    Alpha: [
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          timestamp: T + 25,
          content: [{ type: "text", text: "done" }],
        },
      },
    ],
  });
  h.engine.agentInteractions.ingest("$root", { type: "message_end", message: custom });
  h.engine.agentInteractions.ingest("$root", { type: "message_end", message: custom });
  const snapshot = await h.query();
  assert.equal(snapshot.agents.find((agent) => agent.id === "Alpha")?.status, "success");
  const results = snapshot.events.filter((event) => event.kind === "task_result");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.body, body);
  assert.equal(results[0]?.fromAgentId, "Alpha");
  assert.equal(results[0]?.toAgentId, "main");
  assert.equal(results[0]?.source, "live_and_history");
  zcodeSessionAgentInteractionsResultSchema.parse(snapshot);
});

test("批量后台结果只关联各自真实 job 段，未知身份不补造结果", async () => {
  const h = harness({
    "": [
      spawn("a", "Alpha"),
      spawn("b", "Beta"),
      {
        type: "custom_message",
        customType: "async-result",
        display: true,
        timestamp: T + 50,
        content:
          "<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job Alpha (alpha label) ──\nalpha result\n── Job Beta ──\nbeta result\n</system-notice>",
        details: {
          jobs: [
            { jobId: "Alpha", type: "task" },
            { jobId: "Beta", type: "task" },
            { jobId: "unproven", type: "task" },
          ],
        },
      },
    ],
    Alpha: [],
    Beta: [],
  });
  assert.deepEqual(
    (await h.query()).events
      .filter((e) => e.kind === "task_result")
      .map((e) => [e.fromAgentId, e.body]),
    [
      ["Alpha", "alpha result"],
      ["Beta", "beta result"],
    ],
  );
});

test("原生 write agent:// 的正文和真实 receipts 保留，广播不补造接收人，用户干预不当通信", async () => {
  const h = harness({
    "": [
      spawn("spawn", "Alpha"),
      call("send", "write", { path: "agent://all", content: "hello" }),
      result("send", "write", {
        message: {
          op: "send",
          from: "main",
          to: "all",
          receipts: [
            { to: "Alpha", outcome: "woken" },
            { to: "missing", outcome: "failed", error: "not running" },
          ],
        },
      }),
      {
        type: "message",
        message: { role: "user", attribution: "user", steering: true, content: "steer child" },
      },
    ],
    Alpha: [],
  });
  const snapshot = await h.query();
  const messages = snapshot.events.filter((event) => event.kind === "message");
  assert.deepEqual(
    messages.map((event) => [event.fromAgentId, event.toAgentId, event.body, event.delivery]),
    [
      ["main", "Alpha", "hello", "woken"],
      ["main", "missing", "hello", "failed"],
    ],
  );
  assert.ok(messages.every((event) => event.broadcastGroupId && event.timeBasis === "recorded"));
  assert.equal(messages[1]?.error, "not running");
  assert.equal(snapshot.agents.find((agent) => agent.id === "missing")?.known, false);
  assert.ok(zcodeSessionAgentInteractionsResultSchema.safeParse(snapshot).success);
});

test("原生OMP Main端点统一指向main，子代理标识不改变大小写", async () => {
  const h = harness({
    "": [spawn("spawn", "Alpha"), incoming("reply", "Alpha", "reply")],
    Alpha: [incoming("from-root", "Main", "native root")],
  });
  const snapshot = await h.query();
  assert.equal(
    snapshot.events.find((event) => event.messageId === "from-root")?.fromAgentId,
    "main",
  );
  assert.equal(snapshot.events.find((event) => event.messageId === "reply")?.toAgentId, "main");
  assert.ok(!snapshot.agents.some((agent) => agent.id === "Main"));
  assert.ok(snapshot.agents.some((agent) => agent.id === "Alpha"));
});

test("lowercase main子代理与Main根会话使用独立命名空间，不串live或cold记录", async () => {
  const h = harness({
    "": [spawn("spawn-main", "main"), incoming("to-root", "main", "child to root")],
    main: [incoming("to-child", "Main", "root to child")],
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "irc_message",
    message: (incoming("root-live", "main", "live to root") as { message: unknown }).message,
  });
  h.engine.agentInteractions.ingest("main", {
    type: "irc_message",
    message: (incoming("child-live", "Main", "live to child") as { message: unknown }).message,
  });
  const snapshot = await h.query();
  assert.equal(snapshot.agents.find((agent) => agent.id === "agent:main")?.parentAgentId, "main");
  assert.equal(
    snapshot.events.find((event) => event.messageId === "to-root")?.fromAgentId,
    "agent:main",
  );
  assert.equal(snapshot.events.find((event) => event.messageId === "root-live")?.toAgentId, "main");
  assert.equal(
    snapshot.events.find((event) => event.messageId === "child-live")?.toAgentId,
    "agent:main",
  );
  assert.equal(
    snapshot.events.find((event) => event.messageId === "child-live")?.fromAgentId,
    "main",
  );
});

test("同message ID live/history幂等、同正文不同ID保留，未知时间不制造发送时间", async () => {
  const h = harness({
    "": [
      incoming("one", "Alpha", "same"),
      incoming("two", "Alpha", "same"),
      {
        type: "custom_message",
        customType: "irc:incoming",
        display: true,
        content: "raw",
        details: { id: "unknown-time", from: "Alpha", message: "no time" },
      },
    ],
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "irc_message",
    message: (incoming("one", "Alpha", "same") as { message: unknown }).message,
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "message_end",
    message: (incoming("one", "Alpha", "same") as { message: unknown }).message,
  });
  const snapshot = await h.query();
  assert.equal(snapshot.events.length, 3);
  assert.equal(
    snapshot.events.find((event) => event.messageId === "one")?.source,
    "live_and_history",
  );
  assert.equal(
    snapshot.events.find((event) => event.messageId === "unknown-time")?.timestamp,
    undefined,
  );
  assert.ok(snapshot.coverage.issues.includes("missing_timestamp"));
});

test("只依据每层父task记录读取嵌套后代；结果、父归属与未知sender保留", async () => {
  const h = harness({
    "": [spawn("spawn-alpha", "Alpha"), spawn("spawn-beta", "Beta")],
    Alpha: [spawn("spawn-gamma", "Alpha.Gamma"), incoming("child-in", "Beta", "peer")],
    Beta: [],
    "Alpha/Alpha.Gamma": [
      incoming("deep", "main", "nested"),
      result("wait-child", "wait", { op: "wait", jobs: [] }),
    ],
  });
  const snapshot = await h.query();
  assert.equal(
    snapshot.agents.find((agent) => agent.id === "Alpha/Alpha.Gamma")?.parentAgentId,
    "Alpha",
  );
  assert.equal(
    snapshot.events.find((event) => event.messageId === "deep")?.toAgentId,
    "Alpha/Alpha.Gamma",
  );
  assert.equal(
    snapshot.events.find((event) => event.messageId === "child-in")?.fromAgentId,
    "Beta",
  );
  assert.equal(snapshot.events.filter((event) => event.kind === "task_dispatch").length, 3);
  assert.equal(h.reads(), 4);
});

test("前台task results结构证明归属并产生真实结果，不能只依赖progress", async () => {
  const h = harness({
    "": [
      call("foreground", "task", {}),
      result("foreground", "task", {
        results: [{ id: "sync", agent: "task", task: "build", output: "done", exitCode: 0 }],
      }),
    ],
    sync: [],
  });
  const snapshot = await h.query();
  assert.ok(snapshot.agents.some((agent) => agent.id === "sync" && agent.parentAgentId === "main"));
  assert.deepEqual(
    snapshot.events.map((event) => [event.kind, event.body]),
    [
      ["task_dispatch", "build"],
      ["task_result", "done"],
    ],
  );
});

test("原生wait.waited保留实际发送者、Main接收者、消息ID、回复ID与bus发送时间", async () => {
  const h = harness({
    "": [
      spawn("spawn", "Alpha"),
      result("wait-message", "wait", {
        op: "wait",
        from: "Main",
        waited: {
          id: "native-wait-id",
          from: "Alpha",
          to: "Main",
          body: "native wait body",
          ts: T + 10,
          replyTo: "parent-message",
        },
      }),
    ],
    Alpha: [],
  });
  const event = (await h.query()).events.find((event) => event.messageId === "native-wait-id");
  assert.ok(event);
  assert.deepEqual(
    [
      event.fromAgentId,
      event.toAgentId,
      event.body,
      event.timestamp,
      event.timeBasis,
      event.replyTo,
    ],
    ["Alpha", "main", "native wait body", T + 10, "sent", "parent-message"],
  );
});

test("wait中bash/eval任务不能被同名agent错误归因为代理结果", async () => {
  const h = harness({
    "": [
      spawn("spawn", "Alpha"),
      result("wait-jobs", "wait", {
        op: "wait",
        jobs: [
          { id: "Alpha", type: "bash", status: "completed", resultText: "bash result" },
          { id: "Alpha", type: "eval", status: "completed", resultText: "eval result" },
          { id: "Alpha", type: "task", status: "completed", resultText: "agent result" },
        ],
      }),
    ],
    Alpha: [],
  });
  const events = (await h.query()).events.filter((event) => event.kind === "task_result");
  assert.deepEqual(
    events.map((event) => event.body),
    ["agent result"],
  );
});

test("直接子状态复用原投影目录，目录revision变化刷新缓存，不由root结束推断", async () => {
  const h = harness({ "": [spawn("spawn", "Alpha")], Alpha: [] });
  const projection = new ConversationProjection("root-session");
  projection.beginUserTurn({
    text: "start",
    inputId: "start",
    sourceCommandId: "start",
    clientId: "test",
  });
  projection.upsertSubagent({
    id: "Alpha",
    agent: "task",
    status: "running",
    summaryText: "inspect",
  });
  Object.defineProperty(h.engine, "projection", { value: projection });
  const liveProcess = {};
  Object.defineProperty(h.engine, "subagentProcessHost", {
    value: () => ({
      currentProcess: () => liveProcess,
      observedSubagentStatus: (id: string) => {
        const directory = projection.subagentDirectory(0, 100);
        return [...directory.running, ...directory.ended.items].find((item) => item.agentId === id)
          ?.status;
      },
      ensureStarted: () => assert.fail("read must not start OMP"),
    }),
  });
  const first = await h.query();
  assert.equal(first.agents.find((agent) => agent.id === "Alpha")?.status, "running");
  projection.upsertSubagent({
    id: "Alpha",
    agent: "task",
    status: "success",
    summaryText: "inspect",
  });
  const refreshed = await h.query();
  assert.equal(refreshed.agents.find((agent) => agent.id === "Alpha")?.status, "success");
  assert.ok(refreshed.revision > first.revision);
});

test("纯cold旧pending/running快照只标unknown，explicit wait.completed不被旧目录running覆盖", async () => {
  const h = harness({
    "": [
      spawn("spawn-alpha", "Alpha"),
      spawn("spawn-beta", "Beta"),
      result("wait-alpha", "wait", {
        op: "wait",
        jobs: [
          {
            id: "Alpha",
            agentUrlId: "Alpha",
            type: "task",
            status: "completed",
            resultText: "finished",
          },
        ],
      }),
    ],
    Alpha: [],
    Beta: [],
  });
  const projection = new ConversationProjection("root-session");
  projection.beginUserTurn({
    text: "start",
    inputId: "start",
    sourceCommandId: "start",
    clientId: "test",
  });
  for (const id of ["Alpha", "Beta"])
    projection.upsertSubagent({ id, agent: "task", status: "running", summaryText: "inspect" });
  Object.defineProperty(h.engine, "projection", { value: projection });
  Object.defineProperty(h.engine, "subagentProcessHost", {
    value: () => ({
      currentProcess: () => null,
      ensureStarted: () => assert.fail("cold read must not start OMP"),
    }),
  });
  const snapshot = await h.query();
  assert.equal(snapshot.agents.find((agent) => agent.id === "Alpha")?.status, "completed");
  assert.equal(snapshot.agents.find((agent) => agent.id === "Beta")?.status, "unknown");
});

test("已有实时进程的目录running保留，进程消失使缓存revision刷新为unknown", async () => {
  const h = harness({ "": [spawn("spawn", "Alpha")], Alpha: [] });
  const projection = new ConversationProjection("root-session");
  projection.beginUserTurn({
    text: "start",
    inputId: "start",
    sourceCommandId: "start",
    clientId: "test",
  });
  projection.upsertSubagent({
    id: "Alpha",
    agent: "task",
    status: "running",
    summaryText: "inspect",
  });
  Object.defineProperty(h.engine, "projection", { value: projection });
  let currentProcess: object | null = {};
  Object.defineProperty(h.engine, "subagentProcessHost", {
    value: () => ({
      currentProcess: () => currentProcess,
      observedSubagentStatus: () => (currentProcess ? "running" : undefined),
      ensureStarted: () => assert.fail("observer must not start OMP"),
    }),
  });
  const live = await h.query();
  assert.equal(live.agents.find((agent) => agent.id === "Alpha")?.status, "running");
  currentProcess = null;
  const cold = await h.query();
  assert.equal(cold.agents.find((agent) => agent.id === "Alpha")?.status, "unknown");
  assert.ok(cold.revision > live.revision);
});

test("cold Main进程存在但无child实核证明仍unknown，真实lifecycle证明running且旧进程记录不能复用", async () => {
  const h = harness({ "": [spawn("spawn", "Alpha")], Alpha: [] });
  const projection = new ConversationProjection("root-session");
  projection.beginUserTurn({
    text: "start",
    inputId: "start",
    sourceCommandId: "start",
    clientId: "test",
  });
  projection.upsertSubagent({
    id: "Alpha",
    agent: "task",
    status: "running",
    summaryText: "inspect",
  });
  Object.defineProperty(h.engine, "projection", { value: projection });
  let currentProcess = {
    send: async () => ({ success: true, data: { subagents: [], messages: [] } }),
  } as OmpSessionProcess;
  const bridge = new OmpSubagentBridge(
    projection,
    () => currentProcess,
    () => {},
  );
  Object.defineProperty(h.engine, "subagentProcessHost", {
    value: () => ({
      currentProcess: () => currentProcess,
      observedSubagentStatus: (id: string, process: OmpSessionProcess | null) =>
        bridge.observedSubagentStatus(id, process),
      ensureStarted: () => assert.fail("read must not start OMP"),
    }),
  });
  await bridge.refresh(currentProcess);
  const historical = await h.query();
  assert.equal(historical.agents.find((agent) => agent.id === "Alpha")?.status, "unknown");
  const oldDirectoryRevision = projection.subagentDirectory().revision;
  currentProcess.send = async () => ({
    success: true,
    data: {
      subagents: [{ id: "Alpha", agent: "task", status: "running", description: "inspect" }],
    },
  });
  await bridge.refresh(currentProcess);
  assert.equal(projection.subagentDirectory().revision, oldDirectoryRevision);
  const observed = await h.query();
  assert.equal(observed.agents.find((agent) => agent.id === "Alpha")?.status, "running");
  currentProcess = {
    send: async () => ({ success: true, data: { subagents: [] } }),
  } as OmpSessionProcess;
  const restarted = await h.query();
  assert.equal(restarted.agents.find((agent) => agent.id === "Alpha")?.status, "unknown");
  assert.ok(restarted.revision > observed.revision);
  bridge.handle({
    type: "subagent_lifecycle",
    payload: { id: "Alpha", agent: "task", status: "started", description: "inspect" },
  });
  assert.equal(projection.subagentDirectory().revision, oldDirectoryRevision);
  const liveAgain = await h.query();
  assert.equal(liveAgain.agents.find((agent) => agent.id === "Alpha")?.status, "running");
  assert.ok(liveAgain.revision > restarted.revision);
});

test("嵌套状态只按已证明task的wait.agentUrlId事实更新，bash/eval与未知id不改状态", async () => {
  const h = harness({
    "": [spawn("root-spawn", "Alpha")],
    Alpha: [
      spawn("nested-spawn", "Alpha.Gamma"),
      result("wait-explicit", "wait", {
        op: "wait",
        jobs: [
          {
            id: "job-collision",
            agentUrlId: "Alpha.Gamma",
            type: "task",
            status: "completed",
            resultText: "done",
          },
          { id: "Alpha.Gamma", type: "bash", status: "running", resultText: "shell" },
          { id: "Alpha.Gamma", type: "eval", status: "failed", resultText: "eval" },
          { id: "unproven", type: "task", status: "completed", resultText: "unknown" },
        ],
      }),
    ],
    "Alpha/Alpha.Gamma": [],
  });
  const snapshot = await h.query();
  assert.equal(
    snapshot.agents.find((agent) => agent.id === "Alpha/Alpha.Gamma")?.status,
    "completed",
  );
  assert.ok(!snapshot.agents.some((agent) => agent.id === "unproven"));
  assert.deepEqual(
    snapshot.events.filter((event) => event.kind === "task_result").map((event) => event.body),
    ["done"],
  );
});

test("发送与接收观察只有互为唯一因果时间区间候选才能归并；同正文重复发送保留", async () => {
  const send = (id: string) => [
    call(id, "write", { path: "agent://Alpha", content: "same" }),
    result(id, "write", {
      message: {
        op: "send",
        from: "main",
        to: "Alpha",
        receipts: [{ to: "Alpha", outcome: "injected" }],
      },
    }),
  ];
  const h = harness({
    "": [spawn("spawn", "Alpha"), ...send("send-one")],
    Alpha: [incoming("actual", "main", "same")],
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "message_end",
    message: (
      call("send-one", "write", { path: "agent://Alpha", content: "same" }) as { message: unknown }
    ).message,
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "tool_execution_start",
    toolCallId: "send-one",
    toolName: "write",
    args: { path: "agent://Alpha", content: "same" },
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "tool_execution_end",
    toolCallId: "send-one",
    toolName: "write",
    result: {
      details: {
        message: {
          op: "send",
          from: "Main",
          to: "Alpha",
          receipts: [{ to: "Alpha", outcome: "injected" }],
        },
      },
    },
  });
  h.engine.agentInteractions.ingest("$root", {
    type: "irc_message",
    message: {
      role: "custom",
      customType: "irc:relay",
      display: true,
      timestamp: T + 10,
      content: "wrapped",
      details: { from: "main", to: "Alpha", body: "same" },
    },
  });
  let snapshot = await h.query();
  assert.equal(snapshot.events.filter((event) => event.kind === "message").length, 1);
  assert.equal(snapshot.events.find((event) => event.messageId === "actual")?.delivery, "injected");
  h.records[""]!.push(...send("send-two"));
  h.change();
  snapshot = await h.query();
  assert.equal(snapshot.events.filter((event) => event.kind === "message").length, 3);
  assert.ok(snapshot.coverage.issues.includes("ambiguous_identity"));
});

test("分页绑定快照revision，文件未变不产生新revision；旧scope/过期cursor拒绝", async () => {
  const h = harness({
    "": [
      incoming("one", "Alpha", "1"),
      incoming("two", "Alpha", "2"),
      incoming("three", "Alpha", "3"),
    ],
  });
  const first = await h.query(undefined, 1);
  const unchanged = await h.query();
  assert.equal(unchanged.revision, first.revision);
  h.records[""]!.push(incoming("four", "Alpha", "4"));
  h.change();
  await h.query();
  const oldPage = await h.query(first.nextCursor, 5);
  assert.deepEqual(oldPage.events.map((event) => event.body).sort(), ["2", "3"]);
  h.records[""]!.push(incoming("five", "Alpha", "5"));
  h.change();
  await h.query();
  await assert.rejects(() => h.query(first.nextCursor), /snapshot expired/);
  await assert.rejects(
    () => h.store.query(h.engine, undefined, 200, () => false),
    /session changed/,
  );
});

test("缺ID重复relay同源观察不会按正文消失，冷记录缺失如实partial", async () => {
  const relay = {
    type: "irc_message",
    message: {
      role: "custom",
      customType: "irc:relay",
      display: true,
      content: "text",
      timestamp: T,
      details: { from: "Alpha", to: "Beta", body: "same" },
    },
  };
  const h = harness();
  h.engine.agentInteractions.ingest("$root", relay);
  h.engine.agentInteractions.ingest("$root", relay);
  const snapshot = await h.query();
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.coverage.status, "partial");
  assert.ok(snapshot.coverage.issues.includes("record_unavailable"));
  assert.ok(snapshot.coverage.issues.includes("ambiguous_identity"));
});

test("真实子代理终态详情含IRC/custom字符串content时不崩溃，隐藏custom仍不展示", async () => {
  const projection = new ConversationProjection("parent");
  projection.beginUserTurn({
    text: "start",
    inputId: "start",
    sourceCommandId: "start",
    clientId: "test",
  });
  const process = {
    send: async () => ({
      success: true,
      data: {
        messages: [
          {
            role: "custom",
            customType: "irc:incoming",
            content: "native-string-irc",
            display: true,
            timestamp: T,
          },
          {
            role: "custom",
            customType: "secret",
            content: "hidden-custom",
            display: false,
            timestamp: T,
          },
          { role: "assistant", content: [{ type: "text", text: "finished" }], timestamp: T },
        ],
      },
    }),
  } as OmpSessionProcess;
  const bridge = new OmpSubagentBridge(
    projection,
    () => process,
    () => {},
  );
  bridge.handle({
    type: "subagent_lifecycle",
    payload: { id: "Alpha", agent: "task", status: "completed" },
  });
  await new Promise<void>((done) => setImmediate(done));
  const row = projection.rowsRange(undefined, 100).rows.find((row) => row.kind === "subagent");
  assert.ok(row?.kind === "subagent");
  assert.ok(row.transcriptText?.includes("native-string-irc"));
  assert.ok(row.transcriptText?.includes("finished"));
  assert.ok(!row.transcriptText?.includes("hidden-custom"));
});
