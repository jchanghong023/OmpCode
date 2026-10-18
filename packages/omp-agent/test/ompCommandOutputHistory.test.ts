import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { createOmpStore } from "../src/adapters/ompStore.js";
import { OmpCommandOutputBridge } from "../src/app/ompCommandOutput.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";
import { mergeOmpCommandOutputHistory } from "../src/domain/OmpCommandOutputHistory.js";
import {
  applyConversationDeltas,
  commandAckSchema,
  conversationSnapshotSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { realOmpSkip, startRealOmpHarness } from "./fixtures/realOmpHarness.js";

const cwd = join(tmpdir(), "omp-command-output-workspace");
const output = { id: "output-1", text: "repo index: 8 files", createdAt: 1000 };
const logicalId = "omp-session-command-only";
const stableId = "01a0d66e-1891-7035-ab59-f8e5f0a33703";

async function scratch(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-command-output-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const env = { OMP_CONFIG_ROOT: join(root, "omp") };
  return { root, env, store: createOmpStore(env) };
}

test("仅 command_output 的会话持久恢复，存储去重且不创建 OMP journal", async (context) => {
  const { store, env } = await scratch(context);
  const session = { cwd, sessionId: logicalId, sessionPath: null, title: "/repo" };
  await Promise.all([
    store.appendCommandOutput!(session, output),
    store.appendCommandOutput!(session, {
      id: "output-2",
      text: "repo index ready",
      createdAt: 2000,
    }),
    store.appendCommandOutput!(session, output),
  ]);
  await store.flushCommandOutputs!();
  const reopened = createOmpStore(env);
  const summaries = await reopened.listSessions(cwd);
  assert.deepEqual(summaries, [
    {
      sessionId: logicalId,
      sessionPath: "",
      title: "/repo",
      firstUserText: null,
      createdAt: 1000,
      updatedAt: 2000,
      commandOutputOnly: true,
    },
  ]);
  const records = await reopened.readCommandOutputs!(cwd, logicalId);
  const rows = mergeOmpCommandOutputHistory([], records);
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    [output.text, "repo index ready"],
  );
  assert.equal(new Set(rows.map((row) => row.entityId)).size, 2);
});

test(
  "真实原生命令输出 live→重启冷订阅保留合法重复且不重发模型输入",
  {
    skip: realOmpSkip,
  },
  async (context) => {
    const { root } = await scratch(context);
    const marker = "COMMAND_HISTORY_MODEL_DONE";
    const live = await startRealOmpHarness({ root, handler: () => ({ content: [marker] }) });
    let sessionId: string;
    let expected: string[];
    let expectedCommandOutputs: { id: string; text: string; createdAt: number }[];
    try {
      sessionId = await live.create(
        "command-history",
        "Initialize the command history recovery scenario.",
      );
      await live.waitUntil(() => live.terminal(sessionId));
      assert.equal(live.terminal(sessionId)?.state, "completedSuccess");
      const outputs: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const commandId = `history-native-show-${index}`;
        const prior = new Set(live.rows(sessionId).keys());
        const ack = commandAckSchema.parse(
          await live.request("v4/command", {
            commandId,
            clientId: "history-real-client",
            sessionId,
            type: "sendText",
            payload: { text: "/goal show" },
            issuedAt: Date.now(),
          }),
        );
        assert.equal(ack.status, "accepted");
        const terminal = await live.waitUntil(() =>
          [...live.rows(sessionId).values()].find(
            (row) =>
              row.kind === "turnHeader" &&
              row.sourceCommandId === commandId &&
              ["completedSuccess", "completedInterrupted", "failed"].includes(String(row.state)),
          ),
        );
        assert.equal(terminal.state, "completedSuccess");
        outputs.push(
          await live.waitUntil(() => {
            const text = [...live.rows(sessionId)]
              .filter(([rowId, row]) => !prior.has(rowId) && row.kind === "assistantText")
              .map(([, row]) => String(row.text ?? ""))
              .join("\n");
            return text.trim() ? text : undefined;
          }),
        );
      }
      assert.equal(outputs[0], outputs[1], "相同命令的独立事件必须都保留");
      expected = [...live.rows(sessionId).values()]
        .filter((row) => row.kind === "assistantText")
        .map((row) => String(row.text ?? ""));
      assert.ok(expected.includes(marker), "冷恢复同时保留模型 journal 和派生命令输出");
      assert.ok(expected.filter((text) => text === outputs[0]).length >= 2);
      expectedCommandOutputs = [...live.rows(sessionId).values()]
        .filter((row) => String(row.entityId ?? "").startsWith("omp-command-output:"))
        .map((row) => ({
          id: String(row.entityId),
          text: String(row.text),
          createdAt: Number(row.createdAt),
        }));
      assert.equal(expectedCommandOutputs.length, 2, "同文命令须各有独立 live 输出身份");
    } finally {
      await live.close();
    }
    const cold = await startRealOmpHarness({
      root,
      handler: () => ({ content: ["UNEXPECTED_REPLAY"] }),
    });
    try {
      // 重复公开请求复用 Registry owner；不能直接重复 hydrateRows 伪造业务重入。
      const modes = [
        "desktop-continuous",
        "web-remote-replayable",
        "desktop-continuous",
        "web-remote-replayable",
      ] as const;
      for (const [index, clientMode] of modes.entries()) {
        const { ack } = v4ConversationSubscribeResultSchema.parse(
          await cold.request("v4/conversation/subscribe", {
            topic: `conversation/${sessionId}`,
            connectionId: `history-cold-${clientMode}-${index}`,
            clientMode,
          }),
        );
        const snapshot = await cold.waitUntil(() =>
          cold
            .conversationFrames(sessionId)
            .find(
              (frame) =>
                frame.subscriptionId === ack.subscriptionId && frame.payload.kind === "snapshot",
            ),
        );
        assert.ok(snapshot.payload.kind === "snapshot", "冷恢复必须收到当前订阅的完整 snapshot");
        const parsed = conversationSnapshotSchema.parse(snapshot.payload.snapshot);
        assert.deepEqual(
          parsed.rows.window.filter((row) => row.kind === "assistantText").map((row) => row.text),
          expected,
        );
        assert.deepEqual(
          parsed.rows.window.flatMap((row) =>
            row.kind === "assistantText" && row.entityId?.startsWith("omp-command-output:")
              ? [{ id: row.entityId, text: row.text, createdAt: row.createdAt }]
              : [],
          ),
          expectedCommandOutputs,
          "每次公开冷订阅保留 live ID、全文、时间和顺序，恰好一次",
        );
      }
      assert.equal(cold.mock.calls.length, 0, "冷订阅不能重新执行旧模型输入");
    } finally {
      await cold.close();
    }
  },
);

test("原生文件随后生成时关联 UUID，冷恢复合并模型历史且不复制 journal", async (context) => {
  const { store, env } = await scratch(context);
  const session = { cwd, sessionId: logicalId, sessionPath: null, title: "/wiki" };
  await store.appendCommandOutput!(session, output);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const entries = [
    { type: "session", id: stableId, cwd, timestamp: new Date(100).toISOString() },
    {
      type: "message",
      id: "user-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "actual model prompt" }],
        timestamp: 3000,
      },
      timestamp: new Date(3000).toISOString(),
    },
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "actual model answer" }],
        timestamp: 4000,
      },
      timestamp: new Date(4000).toISOString(),
    },
  ];
  const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(nativePath, journal);
  await store.associateCommandOutputs!({ ...session, sessionPath: nativePath });
  const reopened = createOmpStore(env);
  assert.equal((await reopened.listSessions(cwd)).length, 1);
  assert.equal((await reopened.findSession!(cwd, stableId))?.sessionPath, nativePath);
  assert.equal((await reopened.findSession!(cwd, logicalId))?.sessionPath, nativePath);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, stableId, nativePath), [output]);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), [output]);
  const rows = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(await reopened.readSessionEntries(nativePath)),
    await reopened.readCommandOutputs!(cwd, stableId, nativePath),
    entries,
    stableId,
  );
  assert.equal(
    rows.filter((row) => row.kind === "assistantText" && row.text === output.text).length,
    1,
  );
  assert.ok(rows.some((row) => row.kind === "assistantText" && row.text === "actual model answer"));
  assert.equal(await readFile(nativePath, "utf8"), journal);
});

test("冷合并按输出 ID 去重，保留相同文本的不同事件及原生行", () => {
  const native = rowsFromOmpEntries([
    {
      type: "message",
      id: "native",
      message: { role: "assistant", content: [{ type: "text", text: "model" }], timestamp: 3000 },
    },
  ]);
  const records = [output, output, { ...output, id: "another-event", createdAt: 2000 }];
  const rows = mergeOmpCommandOutputHistory(native, records);
  const twice = mergeOmpCommandOutputHistory(rows, records);
  assert.equal(
    rows.filter((row) => row.kind === "assistantText" && row.text === output.text).length,
    2,
  );
  assert.equal(twice.length, rows.length);
  assert.deepEqual(
    twice.map((row) => row.entityId),
    rows.map((row) => row.entityId),
  );
  assert.deepEqual(
    rows.map((row) => row.rowId),
    rows.map((_, index) => index + 1),
  );
  assert.ok(rows.some((row) => row.kind === "assistantText" && row.text === "model"));
});

test("已合并 Team 输出再次合并不吞掉没有派生副本的同文原生事件", () => {
  const sessionId = stableId;
  const text = "## /team 最终报告\n\n完整的独立报告正文";
  const entries = [
    { type: "session", id: sessionId },
    ...[1000, 2000, 3000].map((timestamp, index) => ({
      type: "custom_message",
      id: `report-${index}`,
      customType: "team-result",
      content: text,
      display: true,
      timestamp,
    })),
  ];
  const records = [1000, 2000].map((timestamp, index) => ({
    id: `live-report-${index}`,
    text,
    createdAt: timestamp - 1,
    customType: "team-result",
    nativeTimestamp: timestamp - 1,
    nativeSessionId: sessionId,
  }));
  const rows = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    records,
    entries,
    sessionId,
  );
  const twice = mergeOmpCommandOutputHistory(rows, [...records, records[0]!], entries, sessionId);
  assert.deepEqual(twice, rows);
  assert.deepEqual(
    rows.map((row) => ({
      id: row.entityId,
      text: row.kind === "assistantText" ? row.text : undefined,
      createdAt: row.createdAt,
    })),
    [
      { id: "omp-command-output:live-report-0", text, createdAt: 999 },
      { id: "omp-command-output:live-report-1", text, createdAt: 1999 },
      {
        id: rowsFromOmpEntries(entries).at(-1)!.entityId,
        text,
        createdAt: 3000,
      },
    ],
  );
  assert.ok(rows[2]!.entityId?.startsWith("omp-native-custom"));
});

test("派生冷合并保留多轮及同轮多段原生历史，不按类别 entityId 覆盖模型回复", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "first", timestamp: 100 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first reasoning" },
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
        ],
        timestamp: 200,
      },
    },
    { type: "message", message: { role: "user", content: "second", timestamp: 300 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "second reasoning" },
          { type: "text", text: "second answer" },
        ],
        timestamp: 400,
      },
    },
  ];
  const native = rowsFromOmpEntries(entries);
  assert.ok(new Set(native.map((row) => row.entityId)).size < native.length);
  const rows = mergeOmpCommandOutputHistory(native, [output, output]);
  const twice = mergeOmpCommandOutputHistory(rows, [output, output]);
  assert.deepEqual(
    rows
      .filter((row) => !row.entityId?.startsWith("omp-command-output:"))
      .map(({ rowId: _rowId, createdAtSeq: _seq, ...row }) => row),
    native.map(({ rowId: _rowId, createdAtSeq: _seq, ...row }) => row),
  );
  assert.deepEqual(twice, rows);
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    ["first paragraph", "second paragraph", "second answer", output.text],
  );
});

test("多条原生 custom 冷恢复各自独立稳定显示组，保留合法重复且不改变模型轮", () => {
  const entries = [
    {
      type: "message",
      id: "user",
      message: { role: "user", content: "model task", timestamp: 100 },
    },
    {
      type: "message",
      id: "model-before",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "model before" }],
        timestamp: 200,
      },
    },
    {
      type: "custom_message",
      id: "dispatch-old",
      // team-dispatch 实测只写 journal、不经 live 通道下发，冷恢复已按类型过滤；
      // 本测试关注分组合并语义，用中性的可见 custom 类型作代表。
      customType: "team-progress",
      content: "team-progress",
      display: true,
      timestamp: 300,
    },
    {
      type: "custom_message",
      id: "incomplete",
      customType: "team-result",
      content: "team-incomplete",
      display: true,
      timestamp: 400,
    },
    {
      type: "custom_message",
      id: "dispatch-new",
      customType: "team-progress",
      content: "team-progress",
      display: true,
      timestamp: 500,
    },
    {
      type: "message",
      id: "model-after",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "model after" }],
        timestamp: 600,
      },
    },
  ];
  const rows = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    [output],
    entries,
    stableId,
  );
  const custom = rows.filter((row) => row.kind === "assistantText" && row.text.startsWith("team-"));
  assert.deepEqual(
    custom.map((row) => row.kind === "assistantText" && row.text),
    ["team-progress", "team-incomplete", "team-progress"],
  );
  assert.equal(
    new Set(custom.map((row) => row.turnId)).size,
    3,
    "latest-assistant 每组仍能显示每条原生报告",
  );
  assert.deepEqual(
    custom.map((row) => row.turnId),
    [
      "omp-native-custom:dispatch-old",
      "omp-native-custom:incomplete",
      "omp-native-custom:dispatch-new",
    ],
  );
  const model = rows.filter((row) => row.kind === "assistantText" && row.text.startsWith("model "));
  assert.equal(model.length, 2);
  assert.equal(model[0]!.turnId, model[1]!.turnId, "custom 不推进或替换原生模型轮");
  assert.ok(custom.every((row) => row.turnId !== model[0]!.turnId));
  assert.deepEqual(
    rowsFromOmpEntries(entries)
      .filter((row) => row.kind === "assistantText" && row.text.startsWith("team-"))
      .map((row) => row.turnId),
    custom.map((row) => row.turnId),
  );
});

test("同 cwd 不同 workspaceIdentity 的 GUI 派生历史隔离", async (context) => {
  const { env } = await scratch(context);
  const remoteA = createOmpStore({ ...env, ZCODE_WORKSPACE_IDENTITY: "remote-a" });
  const remoteB = createOmpStore({ ...env, ZCODE_WORKSPACE_IDENTITY: "remote-b" });
  await remoteA.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  assert.deepEqual(await remoteB.listSessions(cwd), []);
  assert.deepEqual(await remoteB.readCommandOutputs!(cwd, logicalId), []);
  assert.equal((await remoteA.listSessions(cwd)).length, 1);
});

test("OMP 只分配路径未落盘时保留 UUID 冷锚点，存储不返回空文件为 journal", async (context) => {
  const { store, env } = await scratch(context);
  const nativePath = join(
    env.OMP_CONFIG_ROOT,
    "agent",
    "sessions",
    "-",
    `2026-10-08T00-00-00-000Z_${stableId}.jsonl`,
  );
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  const reopened = createOmpStore(env);
  const summaries = await reopened.listSessions(cwd);
  assert.equal(summaries[0]?.sessionId, stableId);
  assert.equal(summaries[0]?.commandOutputOnly, true);
  assert.equal(summaries[0]?.sessionPath, "");
  const records = await reopened.readCommandOutputs!(cwd, stableId);
  // UUID 属于 history 的路径/别名关联；普通 command_output 不携带 custom 事件 epoch。
  assert.deepEqual(records, [output]);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), records);
  assert.equal((await reopened.findSession!(cwd, stableId))?.sessionPath, "");
});

test("首次真正落盘后记录文件事实，外部删除原生会话不会被派生文本复活", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  assert.equal((await store.listSessions(cwd))[0]?.commandOutputOnly, true);
  await mkdir(nativeDirectory, { recursive: true });
  await writeFile(nativePath, `${JSON.stringify({ type: "session", id: stableId, cwd })}\n`);
  assert.equal((await store.listSessions(cwd))[0]?.commandOutputOnly, undefined);
  await rm(nativePath);
  assert.deepEqual(await createOmpStore(env).listSessions(cwd), []);
});

test("派生历史写入失败会显式拒绝，flush 不冒充落盘成功", async (context) => {
  const { root } = await scratch(context);
  const blockedRoot = join(root, "blocked");
  const nativePath = join(root, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const custom = { ...output, customType: "team-result", nativeTimestamp: output.createdAt };
  await writeFile(
    nativePath,
    [
      { type: "session", id: stableId, cwd },
      {
        type: "custom_message",
        customType: custom.customType,
        content: custom.text,
        display: true,
        timestamp: custom.nativeTimestamp,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(`${blockedRoot}_ompcode`, "not a directory");
  const store = createOmpStore({ OMP_CONFIG_ROOT: blockedRoot });
  await assert.rejects(
    store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, custom),
  );
  await assert.rejects(store.flushCommandOutputs!());
});

test("custom 在原生落盘前后均保存 GUI 身份，重启合并保留同文事件且仅显示一次", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const session = { cwd, sessionId: logicalId, sessionPath: nativePath };
  const text = "## /team 最终报告\n\n完整结果😀中文\n\n最后一段必须保留。";
  const records = [1000, 2000].map((timestamp, index) => ({
    id: `live-custom-${index}`,
    text,
    createdAt: timestamp,
    customType: "team-result",
    nativeTimestamp: timestamp,
    nativeSessionId: stableId,
  }));
  await store.appendCommandOutput!(session, records[0]!);
  const entries = [
    { type: "session", id: stableId, cwd },
    ...records.map((record, index) => ({
      type: "custom_message",
      id: `native-custom-${index}`,
      customType: record.customType,
      content: record.text,
      display: true,
      timestamp: record.nativeTimestamp,
    })),
  ];
  await mkdir(nativeDirectory, { recursive: true });
  const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(nativePath, journal);
  // 核心先持久化正文再发 custom 仍必须保存 GUI 已发布身份；同 ID 重投保持幂等。
  await store.appendCommandOutput!(session, records[1]!);
  await store.appendCommandOutput!(session, records[1]!);
  await store.associateCommandOutputs!(session);
  await store.flushCommandOutputs!();
  const reopened = createOmpStore(env);
  const restored = await reopened.readCommandOutputs!(cwd, stableId, nativePath);
  assert.deepEqual(restored, records);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), records);
  const coldEntries = await reopened.readSessionEntries(nativePath);
  const merged = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(coldEntries),
    restored,
    coldEntries,
    stableId,
  );
  assert.deepEqual(
    merged
      .filter((row) => row.kind === "assistantText")
      .map((row) => ({
        id: row.entityId,
        text: row.text,
        createdAt: row.createdAt,
      })),
    records.map((record) => ({
      id: `omp-command-output:${record.id}`,
      text: record.text,
      createdAt: record.createdAt,
    })),
    "两个同文独立事件按原始 ID、全文、时间和顺序恢复，不能只恢复 native 身份",
  );
  assert.deepEqual(mergeOmpCommandOutputHistory(merged, restored, coldEntries, stableId), merged);
  assert.equal(await readFile(nativePath, "utf8"), journal);
});

test("bridge 接纳迟到原生报告以发布时间恢复完成提示之后的完整消费者顺序", async (context) => {
  for (const journalFirst of [true, false]) {
    await context.test(journalFirst ? "原生先落盘" : "原生后落盘", async (context) => {
      const { store, env } = await scratch(context);
      const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
      const sessionPath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
      const session = { cwd, sessionId: logicalId, sessionPath };
      const report = "## /team 最终报告\n\n完整结果😀中文\n\n最后一段必须保留。";
      const entries = [
        { type: "session", id: stableId, cwd },
        ...[1501, 1601].map((timestamp, index) => ({
          type: "custom_message",
          id: `native-late-report-${index}`,
          customType: "team-result",
          content: report,
          display: true,
          timestamp,
        })),
      ];
      const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await mkdir(directory, { recursive: true });
      if (journalFirst) await writeFile(sessionPath, journal);
      const live = new ConversationProjection(logicalId);
      const consumerBase = conversationSnapshotSchema.parse(live.buildSnapshot());
      const bridge = new OmpCommandOutputBridge({
        projection: () => live,
        sessionPath: () => sessionPath,
        save: (record, path) =>
          store.appendCommandOutput!({ ...session, sessionPath: path }, record),
        flush: () => store.flushCommandOutputs!(),
        scheduleFlush: () => {},
      });
      // 复用 Date-only 确定性时钟；不改变 IO/进程或以等待制造时序。
      context.mock.timers.enable({ apis: ["Date"], now: 2000 });
      bridge.emit({ text: "讨论完成" });
      context.mock.timers.setTime(3000);
      bridge.custom({
        role: "custom",
        customType: "team-result",
        content: report,
        display: true,
        timestamp: 1500,
      });
      context.mock.timers.setTime(4000);
      bridge.custom({
        role: "custom",
        customType: "team-result",
        content: report,
        display: true,
        timestamp: 1600,
      });
      await bridge.flush();
      if (!journalFirst) await writeFile(sessionPath, journal);
      await store.associateCommandOutputs!(session);
      await bridge.flush();
      const liveSnapshot = conversationSnapshotSchema.parse(live.buildSnapshot());
      const consumer = applyConversationDeltas(consumerBase, live.drainPendingDeltas());
      assert.deepEqual(consumer.rows, liveSnapshot.rows, "实际增量消费者保留发布顺序");
      const visible = liveSnapshot.rows.window.filter((row) => row.kind === "assistantText");
      assert.deepEqual(
        visible.map((row) => row.text),
        ["讨论完成", report, report],
      );
      assert.deepEqual(
        visible.map((row) => row.createdAt),
        [2000, 3000, 4000],
      );
      assert.equal(new Set(visible.map((row) => row.entityId)).size, 3);
      assert.ok(visible[0]!.entityId?.startsWith("omp-command-output:omp-command-output-"));
      assert.ok(
        visible
          .slice(1)
          .every((row) => row.entityId?.startsWith("omp-command-output:omp-custom-output-")),
      );
      const reopened = createOmpStore(env);
      const restored = await reopened.readCommandOutputs!(cwd, stableId, sessionPath);
      assert.deepEqual(
        restored.map((record) => ({
          id: `omp-command-output:${record.id}`,
          text: record.text,
          createdAt: record.createdAt,
        })),
        visible.map((row) => ({
          id: row.entityId,
          text: row.text,
          createdAt: row.createdAt,
        })),
        "预期身份取自真实 bridge 发布，不手造派生 records 绕开时间所有者",
      );
      assert.deepEqual(
        restored.slice(1).map((record) => record.nativeTimestamp),
        [1500, 1600],
      );
      assert.ok(restored.slice(1).every((record) => record.nativeSessionId === stableId));
      const coldEntries = await reopened.readSessionEntries(sessionPath);
      assert.deepEqual(coldEntries, entries);
      const merged = mergeOmpCommandOutputHistory(
        rowsFromOmpEntries(coldEntries),
        restored,
        coldEntries,
        stableId,
      );
      assert.deepEqual(
        mergeOmpCommandOutputHistory(merged, restored, coldEntries, stableId),
        merged,
      );
      const cold = new ConversationProjection(logicalId);
      cold.hydrateRows(merged);
      assert.deepEqual(
        conversationSnapshotSchema.parse(cold.buildSnapshot()).rows,
        liveSnapshot.rows,
        "冷快照逐字段等于已发布 live 行；原生时间仅匹配，不重排、不多显同文报告",
      );
      assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), restored);
      assert.equal(await readFile(sessionPath, "utf8"), journal, "journal 字节保持不变");
    });
  }
});

test("同文 custom 的旧 journal t1000 不能吞掉未落盘新事件 t2000", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: stableId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(1000).toISOString(),
    },
  ];
  await writeFile(nativePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: nativePath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  assert.equal((await store.readCommandOutputs!(cwd, logicalId)).length, 1);
  const reopened = createOmpStore(env);
  const visible = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    await reopened.readCommandOutputs!(cwd, logicalId),
    entries,
    stableId,
  ).filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    visible.map((row) => row.text),
    [output.text, output.text],
  );
  assert.deepEqual(
    visible.map((row) => row.createdAt),
    [1000, 2000],
  );
});

test("同事件 frame/entry 时间微差按源因果顺序冷去重，不猜时间容差", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: stableId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(2001).toISOString(),
    },
  ];
  await writeFile(nativePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: nativePath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  assert.equal(
    (await store.readCommandOutputs!(cwd, logicalId)).length,
    1,
    "时间不同不能在保存前假定已落盘",
  );
  const visible = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    await createOmpStore(env).readCommandOutputs!(cwd, logicalId),
    entries,
    stableId,
  ).filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    visible.map((row) => row.text),
    [output.text],
  );
});

test("原生 file/UUID 变化后，旧 epoch derived 不匹配新 file 的同文 custom", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const originalPath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const newId = "01a0d66e-1891-7035-ab59-f8e5f0a33704";
  const newPath = join(directory, `2026-10-08T00-00-01-000Z_${newId}.jsonl`);
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: originalPath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: newId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(3000).toISOString(),
    },
  ];
  await writeFile(newPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.associateCommandOutputs!({ cwd, sessionId: logicalId, sessionPath: newPath });
  assert.equal((await store.readCommandOutputs!(cwd, logicalId))[0]!.nativeSessionId, stableId);
  const visible = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    await createOmpStore(env).readCommandOutputs!(cwd, logicalId),
    entries,
    newId,
  ).filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    visible.map((row) => row.text),
    [output.text, output.text],
  );
  assert.deepEqual(
    visible.map((row) => row.createdAt),
    [2000, 3000],
  );
});
