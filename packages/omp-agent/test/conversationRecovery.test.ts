import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  applyConversationDeltas,
  commandAckSchema,
  conversationSnapshotSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import { realOmpSkip, startRealOmpHarness } from "./fixtures/realOmpHarness.js";
import { MOCK_MODEL_ID, MOCK_PROVIDER } from "./fixtures/ompMockServer.mjs";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";
import { mergeOmpCommandOutputHistory } from "../src/domain/OmpCommandOutputHistory.js";
import type { OmpCommandOutputRecord } from "../src/domain/OmpCommandOutput.js";
import { createOmpStore } from "../src/adapters/ompStore.js";

async function scratch(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-conversation-recovery-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const env = { OMP_CONFIG_ROOT: join(root, "omp") };
  return { root, env, store: createOmpStore(env) };
}

function input(id: string, routing: "startNow" | "queue" = "startNow") {
  return { text: id, inputId: id, sourceCommandId: id, clientId: "test", routing };
}

test("queued local command finishes only for its own completion, without agent_start", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("local", "queue"));
  projection.finishTurn("success");
  assert.equal(projection.finishQueuedLocalOnlyTurn(), false);
  assert.deepEqual(
    projection.buildSnapshot().queue.items.map((item) => item.sourceCommandId),
    ["local"],
    "无命令身份的旧完成不能推断队首已执行",
  );
  assert.equal(projection.finishQueuedLocalOnlyTurn("local"), true);
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["completedSuccess", "completedSuccess"],
  );
});

test("failed queued command does not fail the running turn", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("queued", "queue"));
  projection.failCommandTurn("queued", { code: "omp_prompt_failed", message: "offline" });
  assert.equal(projection.stateSnapshot.control.phase, "running");
  projection.finishTurn("success");
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["completedSuccess", "failed"],
  );
});

test("原命令晚到失败不得把后续活跃轮标记失败", () => {
  const projection = new ConversationProjection("late-failure");
  projection.beginUserTurn(input("first"));
  projection.finishTurn("success");
  projection.beginUserTurn(input("second"));
  projection.failCommandTurn("first", { code: "late", message: "old dispatch rejected" });
  assert.equal(projection.stateSnapshot.control.phase, "running");
  assert.equal(projection.lastError, null);
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["completedSuccess", "running"],
  );
});

test("core exit closes active and queued turns", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("queued", "queue"));
  projection.failAllTurns({ code: "omp_process_exit", message: "core exited" });
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["failed", "failed"],
  );
  assert.deepEqual(projection.buildSnapshot().queue.items, []);
  assert.equal(projection.claimQueuedSubmission(1), null);
  assert.deepEqual(projection.lastError, { code: "omp_process_exit", message: "core exited" });
});

test("follow_up 响应不登记收口（真实 omp 从不发 follow_up 的 prompt_result，登记只会滞留泄漏）", () => {
  const tracker = new PromptResultTracker();
  tracker.noteResponse({ id: "follow-up", command: "follow_up", success: true, data: {} });
  assert.equal(tracker.shouldFinish({ id: "follow-up", agentInvoked: false }), false);
});

test("重启复位清除流式和停止标记，新轮不继承崩溃前的中断", () => {
  const projection = new ConversationProjection("restart");
  const projector = new OmpEventProjector(projection);
  projection.beginUserTurn(input("before-exit"));
  projector.handleEvent({ type: "agent_start" });
  projector.noteStopRequested();
  assert.equal(projector.isStreaming, true);
  projection.failAllTurns({ code: "omp_process_exit", message: "core exited" });
  projector.resetForRestart();
  assert.equal(projector.isStreaming, false);
  assert.equal(projection.activeTurnSourceCommandId(), null);
  assert.deepEqual(projection.buildSnapshot().queue.items, []);

  projection.beginUserTurn(input("after-restart"));
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "new response" },
  });
  projector.handleEvent({ type: "agent_end" });
  assert.equal(projection.stateSnapshot.control.phase, "completedSuccess");
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["failed", "completedSuccess"],
  );
});

test("live 与冷恢复公开投影保留各次 read 显示正文和原来源，不消费模型裁剪占位", () => {
  const cases: {
    id: string;
    toolName: string;
    text: string;
    details?: unknown;
    isError?: boolean;
    expected: string;
  }[] = [
    {
      id: "original",
      toolName: "read",
      text: "[Superseded by a newer read of this file]",
      details: {
        displayContent: { text: "export const original = 731;", startLine: 1, lineNumbers: [1] },
        meta: { source: { type: "path", value: "/original/timing.mjs" } },
      },
      expected: "[/original/timing.mjs]\nexport const original = 731;",
    },
    {
      id: "updated",
      toolName: "read",
      text: "different model-only summary",
      details: {
        displayContent: { text: "export const updated = 732;", startLine: 1, lineNumbers: [1] },
        meta: { source: { type: "path", value: "/original/timing.mjs" } },
      },
      expected: "[/original/timing.mjs]\nexport const updated = 732;",
    },
    {
      id: "ordinary",
      toolName: "bash",
      text: "ordinary actual output",
      details: { displayContent: { text: "not read evidence" } },
      expected: "ordinary actual output",
    },
    {
      id: "error",
      toolName: "read",
      text: "Permission denied",
      isError: true,
      details: { displayContent: { text: "must not mask failure" } },
      expected: "Permission denied",
    },
    {
      id: "legacy",
      toolName: "read",
      text: "legacy actual output",
      expected: "legacy actual output",
    },
    {
      id: "malformed",
      toolName: "read",
      text: "actual malformed-metadata output",
      details: { displayContent: { text: 731 } },
      expected: "actual malformed-metadata output",
    },
    {
      id: "empty",
      toolName: "read",
      text: "model-only empty-file description",
      details: { displayContent: { text: "", startLine: 1 } },
      expected: "",
    },
  ];
  const live = new ConversationProjection("saved-read");
  live.beginUserTurn(input("saved-read"));
  // 快照已包含初始输入；模拟生产水位，不能把快照前的 append 再次交给同一消费者。
  live.drainPendingDeltas();
  const consumerBase = live.buildSnapshot();
  const projector = new OmpEventProjector(live);
  for (const item of cases) {
    projector.handleEvent({
      type: "tool_execution_start",
      toolCallId: item.id,
      toolName: item.toolName,
      args: { path: "/requested-alias/timing.mjs" },
    });
    projector.handleEvent({
      type: "tool_execution_end",
      toolCallId: item.id,
      toolName: item.toolName,
      isError: item.isError === true,
      result: { content: [{ type: "text", text: item.text }], details: item.details },
    });
  }
  const cold = new ConversationProjection("saved-read");
  cold.hydrateRows(
    rowsFromOmpEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: 100,
          content: cases.map((item) => ({
            type: "toolCall",
            id: item.id,
            name: item.toolName,
            arguments: { path: "/requested-alias/timing.mjs" },
          })),
        },
      },
      ...cases.map((item, index) => ({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: item.id,
          toolName: item.toolName,
          content: [{ type: "text", text: item.text }],
          details: item.details,
          isError: item.isError === true,
          timestamp: 200 + index,
        },
      })),
    ]),
  );
  const liveSnapshot = conversationSnapshotSchema.parse(live.buildSnapshot());
  const coldSnapshot = conversationSnapshotSchema.parse(cold.buildSnapshot());
  const consumer = applyConversationDeltas(consumerBase, live.drainPendingDeltas());
  assert.deepEqual(consumer.rows, liveSnapshot.rows);
  for (const snapshot of [liveSnapshot, coldSnapshot]) {
    const tools = snapshot.rows.window.filter((row) => row.kind === "toolCall");
    assert.deepEqual(
      tools.map((row) => row.toolCallId),
      cases.map((item) => item.id),
    );
    for (const [index, item] of cases.entries()) {
      const row = tools[index]!;
      assert.equal(row.output?.text, item.expected);
      assert.equal(row.status, item.isError ? "error" : "success");
      assert.deepEqual(row.input, { path: "/requested-alias/timing.mjs" });
      if (snapshot === coldSnapshot) {
        assert.equal(row.createdAt, 100);
        assert.equal(row.endedAt, 200 + index);
      }
    }
  }
});

test("真实 team-result 经已落盘 journal 和公开存储重开后保留 live 身份、全文与顺序且仅显示一次", async (context) => {
  // qifspE 的 live 全通过后，cold 丢失最终报告的显示 ID；正文已在原生 journal。
  // 必须先落盘原生事实，再持久化 live 显示，覆盖 append 把“已落盘”误作“已保存显示身份”。
  const { root, env, store } = await scratch(context);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const report =
    String.raw`## /team 多代理讨论结果（team-result）

# NATIVE_TEAM_REPORT_731

## Requirement and acceptance

NATIVE_TEAM_731: read native-read.txt and report the exact timing evidence; do not edit any file

Report the exact file evidence without editing files

## Investigated and reviewed directions

The independent read-only proposals preserve the file and report F:\Temp\User\ompcode-core-gui-wUN8b7\workspace\native-read.txt: NATIVE_REAL_READ_731.

They have the same scope and evidence; no distinct trade-off favors one.

## Risks, assumptions and pre-execution checks

No file modification is authorized. Re-read the source before any later implementation.

No unresolved requirement interpretation or rejected alternative was identified.

### 方案状态（结构化追踪，机械生效）

| 方案 | 状态 | 参与情况 |
| --- | --- | --- |
| 方案 A | ✅ 可作为选项 | 提案（会话模型）；审查轮数 1；修订轮数 0 |
| 方案 B | ✅ 可作为选项 | 提案（会话模型）；审查轮数 1；修订轮数 0 |
| 方案 C | ✅ 可作为选项 | 提案（会话模型）；审查轮数 1；修订轮数 0 |


> 选择方案请直接回复（如"选择方案 A"）。选择仅确认该方案、其验收标准与执行前检查，不触发实施；如需修改代码，请另行明确要求。若存在影响选择的"需求理解差异"，请先回答该差异并带答案重跑 ` +
    "`/team`" +
    String.raw`，不要在不同前提的方案间盲选。`;
  const sessionId = "01a1502a-aec7-746a-8892-dc69bd148c93";
  const entryTime = Date.parse("2026-10-18T18:04:00.337Z");
  const native = {
    type: "custom_message",
    customType: "team-result",
    content: report,
    display: true,
    details: {
      jobId: "bg_1",
      question:
        "NATIVE_TEAM_731: read native-read.txt and report the exact timing evidence; do not edit any file",
    },
    attribution: "agent",
    id: "e062ea56",
    parentId: "7f30ff04",
    timestamp: "2026-10-18T18:04:00.337Z",
    runtime: { version: "18.12.1" },
  };
  const entries = [
    { type: "session", id: sessionId, cwd, timestamp: new Date(entryTime - 20).toISOString() },
    { ...native, customType: "team-dispatch", id: "dispatch", content: "dispatch only" },
    native,
    // 同文独立事件仍须逐条保留，不能把文本作为全局身份。
    { ...native, id: "second-report", timestamp: new Date(entryTime + 100).toISOString() },
  ];
  const reportOutput: OmpCommandOutputRecord = {
    id: "omp-custom-output-mve4wus3-tg-45229e",
    text: report,
    createdAt: entryTime - 1,
    customType: "team-result",
    nativeTimestamp: entryTime - 1,
    nativeSessionId: sessionId,
  };
  const outputs: OmpCommandOutputRecord[] = [
    { id: "before-report", text: "No goal set.", createdAt: entryTime - 10 },
    reportOutput,
    {
      ...reportOutput,
      id: "second-report-output",
      createdAt: entryTime + 99,
      nativeTimestamp: entryTime + 99,
    },
    {
      id: "after-report",
      text: "Document indexes: native-timing-reference-731",
      createdAt: entryTime + 200,
    },
  ];
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const sessionPath = join(nativeDirectory, `2026-10-18T18-04-00-337Z_${sessionId}.jsonl`);
  const journalBefore = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(sessionPath, journalBefore);
  const session = { cwd, sessionId, sessionPath, title: "/team" };
  const live = new ConversationProjection(sessionId);
  const consumerBase = conversationSnapshotSchema.parse(live.buildSnapshot());
  for (const output of outputs) {
    live.appendCommandOutput(output);
    await store.appendCommandOutput!(session, output);
  }
  // 同一公开事件重复到达不能新增行；同文但独立 ID 的第二份报告必须仍保留。
  for (const output of outputs) await store.appendCommandOutput!(session, output);
  await store.flushCommandOutputs!();
  const reopened = createOmpStore(env);
  const persistedEntries = await reopened.readSessionEntries(sessionPath);
  const persistedOutputs = await reopened.readCommandOutputs!(cwd, sessionId, sessionPath);
  const expected = outputs.map((output) => ({
    id: `omp-command-output:${output.id}`,
    text: output.text,
    createdAt: output.createdAt,
  }));
  const merged = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(persistedEntries),
    persistedOutputs,
    persistedEntries,
    sessionId,
  );
  const repeated = mergeOmpCommandOutputHistory(
    merged,
    [...persistedOutputs, ...persistedOutputs],
    persistedEntries,
    sessionId,
  );
  assert.deepEqual(repeated, merged, "重复纯合并保留每个事件的全部字段且不重复");
  const liveSnapshot = conversationSnapshotSchema.parse(live.buildSnapshot());
  const consumer = applyConversationDeltas(consumerBase, live.drainPendingDeltas());
  assert.deepEqual(consumer.rows, liveSnapshot.rows, "live 消费者收到完整显示快照");
  for (const rows of [merged, repeated]) {
    // hydrateRows 只初始化新投影；公开重复订阅由 Registry 复用 owner，
    // 不会再次调用初始化追加。公开重复请求另由真实冷订阅回归覆盖。
    const cold = new ConversationProjection(sessionId);
    cold.hydrateRows(rows);
    assert.deepEqual(
      conversationSnapshotSchema.parse(cold.buildSnapshot()).rows,
      liveSnapshot.rows,
      "真实存储重开后的完整历史行与 live 快照一致",
    );
    for (const projection of [live, cold]) {
      const snapshot = conversationSnapshotSchema.parse(projection.buildSnapshot());
      const visible = snapshot.rows.window.filter((row) => row.kind === "assistantText");
      assert.deepEqual(
        visible.map((row) => ({ id: row.entityId, text: row.text, createdAt: row.createdAt })),
        expected,
      );
      assert.deepEqual(snapshot.queue.items, []);
    }
  }
  assert.deepEqual(persistedOutputs, outputs, "存储保留独立事件的全部显示元数据且按 ID 幂等");
  assert.deepEqual(
    await reopened.readCommandOutputs!(cwd, sessionId, sessionPath),
    persistedOutputs,
    "重复公开读回不消费显示记录",
  );
  assert.deepEqual(persistedEntries, entries, "公开 journal 读回保留全部原生事件");
  assert.equal(
    await readFile(sessionPath, "utf8"),
    journalBefore,
    "存储和冷投影不得改写 journal 字节",
  );
});

test("read 的终态首次落位也使用原显示证据，取消仍保留实际结果", () => {
  const projection = new ConversationProjection("read-first-result");
  projection.beginUserTurn(input("read-first-result"));
  const details = { displayContent: { text: "saved original body", startLine: 1 } };
  projection.upsertToolCall({
    toolCallId: "completed",
    toolName: "read",
    status: "success",
    outputText: "model-only text",
    resultDetails: details,
    endedAt: 200,
  });
  projection.upsertToolCall({
    toolCallId: "cancelled",
    toolName: "read",
    status: "cancelled",
    outputText: "actual interrupted output",
    resultDetails: details,
    endedAt: 201,
  });
  const tools = projection.buildSnapshot().rows.window.filter((row) => row.kind === "toolCall");
  assert.deepEqual(
    tools.map((row) => [row.toolCallId, row.status, row.output?.text, row.endedAt]),
    [
      ["completed", "success", "saved original body", 200],
      ["cancelled", "cancelled", "actual interrupted output", 201],
    ],
  );
});

test(
  "真实冷会话订阅与紧接发送交付快照，并刷新核心模型和上下文详情",
  { skip: realOmpSkip },
  async () => {
    const harness = await startRealOmpHarness({
      responses: [
        { content: ["STATUS_CONTEXT_DONE"], usage: { input: 512, output: 37 } },
        { content: ["STATUS_NEXT_ACTIVITY_DONE"] },
      ],
    });
    try {
      const created = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "status-create",
          clientId: "status-client",
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: "real-e2e-workspace" },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(created.status, "accepted");
      const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(created.result);
      const [subscription, sent] = await Promise.all([
        harness.request("v4/conversation/subscribe", {
          topic: `conversation/${sessionId}`,
          connectionId: "status-desktop",
          clientMode: "desktop-continuous",
        }),
        harness.request("v4/command", {
          commandId: "status-send",
          clientId: "status-client",
          sessionId,
          type: "sendText",
          payload: { text: "Report status for this real session." },
          issuedAt: Date.now(),
        }),
      ]);
      const desktop = v4ConversationSubscribeResultSchema.parse(subscription);
      assert.equal(desktop.ack.mode, "snapshot");
      assert.equal(commandAckSchema.parse(sent).status, "accepted");
      await harness.waitUntil(() => harness.terminal(sessionId)?.state === "completedSuccess");
      await harness.waitUntil(() => {
        const snapshot = conversationSnapshotSchema.safeParse(harness.state(sessionId));
        if (!snapshot.success) return false;
        const context = snapshot.data.usage.contextWindow;
        return (
          context && context.usedTokens > 0 && context.details && context.details.entries.length > 0
        );
      });
      const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
      assert.equal(snapshot.config.provider, MOCK_PROVIDER);
      assert.equal(snapshot.config.model, MOCK_MODEL_ID);
      assert.equal(snapshot.usage.contextWindow?.maxTokens, 200_000);
      assert.ok(snapshot.usage.cumulative.inputTokens > 0);
      assert.ok(snapshot.usage.cumulative.outputTokens > 0);
      assert.equal(snapshot.control.phase, "completedSuccess");
      const rows = [...harness.rows(sessionId).values()];
      assert.equal(
        rows.filter((row) => row.kind === "userInput" && row.sourceCommandId === "status-send")
          .length,
        1,
      );
      assert.ok(
        rows.some((row) => row.kind === "assistantText" && row.text === "STATUS_CONTEXT_DONE"),
      );
      assert.equal(harness.mock.calls.length, 1, "状态读取和订阅不得额外发起模型请求");
      const timesSchema = z.object({
        session: z.object({ createdAt: z.number(), updatedAt: z.number() }),
      });
      const observedTimes = timesSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionRead, { sessionId }),
      ).session;
      const repeatedReads = await Promise.all(
        Array.from({ length: 3 }, () =>
          harness.request(zcodeProtocolMethods.sessionRead, { sessionId }),
        ),
      );
      for (const read of repeatedReads) {
        assert.deepEqual(timesSchema.parse(read).session, observedTimes);
      }
      const listed = z
        .object({
          sessions: z.array(
            z.object({
              sessionId: z.string(),
              createdAt: z.number(),
              updatedAt: z.number(),
            }),
          ),
        })
        .parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.createdAt, observedTimes.createdAt);
      assert.equal(listed.sessions[0]?.updatedAt, observedTimes.updatedAt);

      const web = v4ConversationSubscribeResultSchema.parse(
        await harness.request("v4/conversation/subscribe", {
          topic: `conversation/${sessionId}`,
          connectionId: "status-web",
          clientMode: "web-remote-replayable",
        }),
      );
      const replay = await harness.waitUntil(() =>
        harness
          .conversationFrames(sessionId)
          .find(
            (frame) =>
              frame.subscriptionId === web.ack.subscriptionId && frame.payload.kind === "snapshot",
          ),
      );
      assert.equal(replay.payload.kind, "snapshot");
      if (replay.payload.kind !== "snapshot") throw new Error("missing status snapshot");
      assert.deepEqual(replay.payload.snapshot.usage, snapshot.usage);
      assert.deepEqual(replay.payload.snapshot.config, snapshot.config);
      assert.equal(replay.payload.snapshot.control.phase, "completedSuccess");
      assert.deepEqual(
        timesSchema.parse(await harness.request(zcodeProtocolMethods.sessionRead, { sessionId }))
          .session,
        observedTimes,
        "A new topic subscription/bootstrap is a read, not new conversation activity",
      );
      const next = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "status-next-activity",
          clientId: "status-client",
          sessionId,
          type: "sendText",
          payload: { text: "Create genuine new conversation activity." },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(next.status, "accepted");
      await harness.waitUntil(() =>
        [...harness.rows(sessionId).values()].some(
          (row) => row.kind === "assistantText" && row.text === "STATUS_NEXT_ACTIVITY_DONE",
        ),
      );
      const advancedTimes = timesSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionRead, { sessionId }),
      ).session;
      assert.equal(advancedTimes.createdAt, observedTimes.createdAt);
      assert.ok(
        advancedTimes.updatedAt > observedTimes.updatedAt,
        "New real input/output advances activity",
      );
      assert.equal(harness.mock.calls.length, 2);
    } finally {
      await harness.close();
    }
  },
);
