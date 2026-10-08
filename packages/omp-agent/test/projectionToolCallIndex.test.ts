import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import type {
  ConversationRow,
  ConversationSnapshot,
  ToolCallRow,
  TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  TopicWireFrameAssembler,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { ConversationTopicPublisher } from "../src/app/topicPublisher.js";

function begin(projection: ConversationProjection): void {
  projection.beginUserTurn({
    text: "tool test",
    inputId: "input",
    sourceCommandId: "command",
    clientId: "test",
  });
}

function tool(rowId: number, toolCallId: string): ToolCallRow {
  return {
    rowId,
    turnId: "history",
    productTurnId: "history",
    entityId: `tool-${toolCallId}`,
    createdAtSeq: 0,
    createdAt: 1,
    kind: "toolCall",
    toolCallId,
    toolName: "write",
    status: "running",
    inputText: "",
    input: { path: "indexed.txt", content: "one\ntwo\n" },
  };
}

function text(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: "history",
    productTurnId: "history",
    entityId: `text-${rowId}`,
    createdAtSeq: 0,
    createdAt: 1,
    kind: "assistantText",
    assistantResponseId: `response-${rowId}`,
    text: "historic text",
    state: "complete",
  };
}

test("5 万历史行上的 100 次工具更新不访问无关历史行，终态内容与文件统计完整", (t) => {
  const projection = new ConversationProjection("indexed-history");
  let historyVisits = 0;
  const rows = Array.from({ length: 50_000 }, (_, index) => {
    const row = text(index + 1);
    Object.defineProperty(row, "kind", {
      enumerable: true,
      get: () => {
        historyVisits += 1;
        return "assistantText";
      },
    });
    return row;
  });
  projection.hydrateRows([...rows, tool(50_001, "target")]);
  begin(projection);
  projection.drainPendingDeltas();
  const initialSeq = projection.seq;
  historyVisits = 0;
  const started = performance.now();
  for (let index = 0; index < 100; index += 1)
    projection.upsertToolCall({
      toolCallId: "target",
      toolName: "write",
      status: "running",
      outputText: `chunk-${index}`,
    });
  const elapsed = performance.now() - started;
  const measuredVisits = historyVisits;
  t.diagnostic(
    JSON.stringify({
      node: process.version,
      historyRows: rows.length,
      updates: 100,
      historyVisits: measuredVisits,
      elapsedMs: Number(elapsed.toFixed(2)),
    }),
  );
  assert.equal(projection.seq, initialSeq + 100);
  projection.upsertToolCall({
    toolCallId: "target",
    toolName: "write",
    status: "success",
    outputText: "complete output",
    endedAt: 1234,
  });
  const deltas = projection.drainPendingDeltas();
  assert.ok(deltas.every((delta) => delta.op === "row.upserted"));
  const result = projection.rowsRange(undefined, 10).rows;
  const target = result.find((row) => row.kind === "toolCall");
  assert.equal(target?.kind === "toolCall" && target.rowId, 50_001);
  assert.equal(target?.kind === "toolCall" && target.status, "success");
  assert.equal(target?.kind === "toolCall" && target.output?.text, "complete output");
  assert.equal(target?.kind === "toolCall" && target.endedAt, 1234);
  const header = result.find((row) => row.kind === "turnHeader");
  assert.deepEqual(header?.kind === "turnHeader" && header.fileChanges, {
    files: 1,
    additions: 2,
    deletions: 0,
  });
  assert.equal(projection.rowIdOfToolCall("target"), 50_001);
  assert.equal(measuredVisits, 0);
});

test("重复工具 ID 保留首行更新与最近权限锚定，重水合替换及时移除旧 ID", () => {
  const projection = new ConversationProjection("duplicate-tool-ids");
  projection.hydrateRows([tool(40, "duplicate"), tool(10, "duplicate")]);
  begin(projection);
  assert.equal(projection.rowIdOfToolCall("duplicate"), 40);
  projection.upsertToolCall({
    toolCallId: "duplicate",
    toolName: "write",
    status: "running",
    outputText: "first insertion",
  });
  assert.equal(
    projection
      .rowsRange(undefined, 100)
      .rows.find((row): row is ToolCallRow => row.rowId === 40 && row.kind === "toolCall")?.output
      ?.text,
    "first insertion",
  );
  projection.mergeRows([{ ...tool(40, "renamed"), output: { text: "replacement" } }]);
  assert.equal(projection.rowIdOfToolCall("duplicate"), 10);
  assert.equal(projection.rowIdOfToolCall("renamed"), 40);
  projection.upsertToolCall({
    toolCallId: "duplicate",
    toolName: "write",
    status: "running",
    outputText: "remaining duplicate",
  });
  projection.mergeRows([text(10)]);
  assert.equal(projection.rowIdOfToolCall("duplicate"), null);
  projection.upsertToolCall({ toolCallId: "duplicate", toolName: "write", status: "running" });
  assert.ok((projection.rowIdOfToolCall("duplicate") ?? 0) > 40);
  // 原 rowId 的 Map 顺序不能因先变成文本再变回工具而被误当作最新插入。
  projection.mergeRows([tool(10, "duplicate")]);
  projection.upsertToolCall({
    toolCallId: "duplicate",
    toolName: "write",
    status: "running",
    outputText: "original insertion order",
  });
  const restored = projection.rowsRange(undefined, 100).rows.find((row) => row.rowId === 10);
  assert.equal(restored?.kind === "toolCall" && restored.output?.text, "original insertion order");
});

test("工具追加、更新和删除屏障的 Desktop 增量与 Web 快照/重放保持一致", () => {
  const projection = new ConversationProjection("tool-delivery");
  projection.hydrateRows([tool(1, "removed")]);
  let desktop = projection.buildSnapshot();
  begin(projection);
  projection.upsertToolCall({
    toolCallId: "new",
    toolName: "write",
    status: "running",
    input: { path: "fresh.txt", content: "new\n" },
  });
  const runningSeq = projection.seq;
  const liveDeltas = projection.drainPendingDeltas();
  desktop = applyConversationDeltas(desktop, liveDeltas);
  projection.upsertToolCall({
    toolCallId: "new",
    toolName: "write",
    status: "success",
    outputText: "written",
  });
  projection.finishTurn("success");
  desktop = applyConversationDeltas(desktop, projection.drainPendingDeltas());
  const completed = conversationSnapshotSchema.parse(projection.buildSnapshot());
  assert.deepEqual(desktop.rows, completed.rows);
  assert.deepEqual(desktop.control, completed.control);
  const replay = projection.deltasBetween(runningSeq, projection.seq);
  assert.ok(replay);
  assert.ok(
    replay.some(
      (delta) =>
        delta.op === "row.upserted" &&
        delta.row.kind === "toolCall" &&
        delta.row.status === "success",
    ),
  );
  projection.replaceHydratedRows([tool(90, "replacement")]);
  const replacedDeltas = projection.drainPendingDeltas();
  assert.equal(replacedDeltas[0]?.op, "row.removed");
  desktop = applyConversationDeltas(desktop, replacedDeltas);
  const replacement = conversationSnapshotSchema.parse(projection.buildSnapshot());
  assert.deepEqual(desktop.rows, replacement.rows);
  assert.equal(projection.rowIdOfToolCall("removed"), null);
  assert.equal(projection.rowIdOfToolCall("new"), null);
  assert.equal(projection.rowIdOfToolCall("replacement"), 90);
  const cold = new ConversationProjection("tool-delivery");
  cold.hydrateRows(replacement.rows.window);
  assert.equal(cold.rowIdOfToolCall("replacement"), 90);
  projection.replaceHydratedRows([]);
  assert.equal(projection.rowIdOfToolCall("replacement"), null);
});

test("实际 topic 发布入口交付工具终态，Web 按旧水位恢复并能重取同一快照", () => {
  const projection = new ConversationProjection("tool-topic");
  projection.hydrateRows([tool(1, "historical")]);
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const received = new Map<string, ConversationSnapshot>();
  const deliveryKinds: string[] = [];
  let recoveringBase: ConversationSnapshot | undefined;
  const publisher = new ConversationTopicPublisher("tool-topic", projection, {
    emitFrame(wire) {
      for (const event of assembler.accept(wire as TopicWireFrameCandidate)) {
        assert.equal(event.kind, "complete");
        if (event.kind !== "complete") continue;
        const frame = event.frame;
        deliveryKinds.push(event.deliveryKind);
        if (frame.payload.kind === "snapshot")
          received.set(frame.subscriptionId, frame.payload.snapshot);
        else {
          const previous = received.get(frame.subscriptionId) ?? recoveringBase;
          assert.ok(previous);
          assert.equal(frame.fromSeq, previous.seq);
          received.set(frame.subscriptionId, {
            ...applyConversationDeltas(previous, frame.payload.deltas),
            seq: frame.toSeq,
          });
        }
      }
    },
    async requestUserInput() {
      return { action: "cancel" };
    },
  });
  try {
    const desktop = publisher.subscribe({
      connectionId: "desktop",
      clientMode: "desktop-continuous",
    });
    const web = publisher.subscribe({ connectionId: "web", clientMode: "web-remote-replayable" });
    const initialWeb = received.get(web.subscriptionId)!;
    publisher.setConnectionFlowState("web", "saturated");
    begin(projection);
    projection.upsertToolCall({
      toolCallId: "live",
      toolName: "write",
      status: "running",
      input: { path: "fresh.txt", content: "live\n" },
    });
    publisher.setConnectionFlowState("desktop", "drained");
    projection.upsertToolCall({
      toolCallId: "live",
      toolName: "write",
      status: "success",
      outputText: "complete",
    });
    projection.finishTurn("success");
    publisher.setConnectionFlowState("desktop", "drained");
    const final = projection.buildSnapshot();
    assert.deepEqual(received.get(desktop.subscriptionId), final);
    assert.equal(received.get(web.subscriptionId), initialWeb);
    publisher.unsubscribe(web.subscriptionId);
    // 新连接沿旧水位恢复；旧快照就是该订阅 reader 的恢复基线。
    recoveringBase = initialWeb;
    const recovering = publisher.subscribe({
      connectionId: "recovering",
      clientMode: "web-remote-replayable",
      base: { logEpoch: projection.logEpoch, seq: initialWeb.seq },
    });
    assert.equal(recovering.mode, "resume");
    assert.deepEqual(received.get(recovering.subscriptionId), final);
    publisher.resync(recovering.subscriptionId, null, true);
    assert.deepEqual(received.get(recovering.subscriptionId), final);
    assert.ok(deliveryKinds.includes("online"));
    assert.ok(deliveryKinds.includes("recovery"));
  } finally {
    publisher.dispose();
  }
});
