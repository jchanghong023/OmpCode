import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { commandAckSchema, pendingInteractionSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

type Row = Record<string, unknown>;
const clientId = "native-control-client";

function command(
  sessionId: string,
  commandId: string,
  type: "sendText" | "resolveInteraction" | "stop",
  payload: Record<string, unknown>,
) {
  return { commandId, clientId, sessionId, type, payload, issuedAt: Date.now() };
}

async function commandTerminal(
  harness: RealOmpHarness,
  sessionId: string,
  commandId: string,
): Promise<Row> {
  return harness.waitUntil(() =>
    [...harness.rows(sessionId).values()].find(
      (row) =>
        row.kind === "turnHeader" &&
        row.sourceCommandId === commandId &&
        ["completedSuccess", "completedInterrupted", "failed"].includes(String(row.state)),
    ),
  );
}

async function nativeOutput(
  harness: RealOmpHarness,
  sessionId: string,
  commandId: string,
  text: string,
): Promise<string> {
  const previousRows = new Set(harness.rows(sessionId).keys());
  const ack = commandAckSchema.parse(
    await harness.request("v4/command", command(sessionId, commandId, "sendText", { text })),
  );
  assert.equal(ack.status, "accepted");
  const terminal = await commandTerminal(harness, sessionId, commandId);
  assert.equal(terminal.state, "completedSuccess", JSON.stringify(terminal));
  return harness.waitUntil(() => {
    const output = [...harness.rows(sessionId)]
      .filter(([rowId, row]) => !previousRows.has(rowId) && row.kind === "assistantText")
      .map(([, row]) => String(row.text ?? ""))
      .join("\n");
    return output.trim() ? output : undefined;
  });
}

function pendingInteractions(harness: RealOmpHarness, sessionId: string) {
  return z.array(pendingInteractionSchema).parse(harness.state(sessionId).pendingInteractions);
}

for (const control of ["resolveInteraction", "stop"] as const) {
  test(
    `真实原生 goal confirm 未返回 send ACK 时，${control} 控制回路可达`,
    { skip: realOmpSkip, concurrency: true },
    async () => {
      const objective = `NATIVE_CONTROL_GOAL_${control}`;
      const marker = `NATIVE_CONTROL_READY_${control}`;
      // 现有隔离配置禁用 goal 自动续轮；只给 /goal set 发起的一次真实模型轮提供响应。
      const harness = await startRealOmpHarness({ responses: [{ content: [marker] }] });
      let pendingSend: Promise<unknown> | undefined;
      try {
        // OMP builtin-modes.ts 的公开 set/show/pause/drop → rpc-goal.ts handleSlash。
        // drop 仅对已有 goal 调用同步 ui.confirm；暂停使测试不依赖目标自动运行时序。
        const sessionId = await harness.create(`native-${control}`, `/goal set ${objective}`);
        await harness.waitUntil(() =>
          [...harness.rows(sessionId).values()].some(
            (row) => row.kind === "assistantText" && String(row.text ?? "").includes(marker),
          ),
        );
        const setup = await commandTerminal(harness, sessionId, `real-create-native-${control}`);
        assert.equal(setup.state, "completedSuccess", JSON.stringify(setup));
        await nativeOutput(harness, sessionId, "native-goal-pause", "/goal pause");
        const before = await nativeOutput(harness, sessionId, "native-goal-before", "/goal show");
        assert.ok(before.includes(`Objective: ${objective}`), "真实核心必须已持有本次 goal");
        assert.match(before, /^Status: paused$/mu);
        assert.equal(harness.mock.calls.length, 1);
        assert.ok(JSON.stringify(harness.mock.calls[0].context.messages).includes(objective));

        let sendFinished = false;
        pendingSend = harness
          .request(
            "v4/command",
            command(sessionId, "native-goal-drop", "sendText", { text: "/goal drop" }),
          )
          .then((result) => {
            sendFinished = true;
            return result;
          });
        // 如前面的断言失败，finally 关闭进程也会拒绝仍等待的请求；保留原 Promise 供下方验收。
        void pendingSend.catch(() => {});
        const card = await harness.waitUntil(() => pendingInteractions(harness, sessionId)[0]);
        assert.equal(card.payload.kind, "userInput");
        if (card.payload.kind !== "userInput") assert.fail("goal drop 必须进入原生确认回路");
        assert.match(card.payload.prompt, /goal/iu);
        assert.equal(card.payload.freeText, false);
        assert.equal(card.payload.options, undefined, "真实 confirm 不能被 select/工具审批替代");
        assert.equal(sendFinished, false, "同步 confirm 的 send ACK 必须仍在等待");

        const invalid = await harness.rawRequest(
          "v4/command",
          command(sessionId, "native-invalid-answer", "resolveInteraction", {
            interactionId: card.interactionId,
            answer: { action: "invalid" },
          }),
        );
        assert.equal(z.object({ code: z.number() }).parse(invalid.error).code, -32602);
        assert.equal(sendFinished, false, "非法回答不能释放同步命令");
        assert.equal(pendingInteractions(harness, sessionId)[0]?.interactionId, card.interactionId);

        const payload =
          control === "stop"
            ? {}
            : { interactionId: card.interactionId, answer: { action: "accept" } };
        const foreign = await harness.rawRequest(
          "v4/command",
          command("unknown-native-session", "native-foreign-control", control, payload),
        );
        assert.equal(z.object({ code: z.number() }).parse(foreign.error).code, -32004);
        assert.equal(sendFinished, false, "外会话控制不能释放当前会话命令");
        assert.equal(pendingInteractions(harness, sessionId)[0]?.interactionId, card.interactionId);

        const envelope = command(sessionId, "native-control", control, payload);
        const result = await harness.request("v4/command", envelope);
        assert.equal(commandAckSchema.parse(result).status, "accepted");
        const duplicate = await harness.request("v4/command", envelope);
        assert.deepEqual(duplicate, result, "重复 commandId 必须复用原 owner 的幂等结果");
        assert.equal(commandAckSchema.parse(await pendingSend).status, "accepted");
        assert.equal(sendFinished, true);
        await harness.waitUntil(() => pendingInteractions(harness, sessionId).length === 0);
        const terminal = await commandTerminal(harness, sessionId, "native-goal-drop");
        assert.ok(
          ["completedSuccess", "completedInterrupted"].includes(String(terminal.state)),
          JSON.stringify(terminal),
        );
        assert.equal(
          [...harness.rows(sessionId).values()].filter(
            (row) => row.kind === "turnHeader" && row.sourceCommandId === "native-goal-drop",
          ).length,
          1,
          "同步命令只执行并收口一次",
        );

        // 不依赖旧 fake 的“取消”输出：再次询问真实核心，检查实际持有的目标状态。
        const after = await nativeOutput(harness, sessionId, "native-goal-after", "/goal show");
        if (control === "stop") {
          assert.ok(after.includes(`Objective: ${objective}`), "取消 confirm 后必须保留原目标");
          assert.match(after, /^Status: paused$/mu);
        } else {
          assert.ok(!after.includes(objective), "确认 drop 后真实核心不再持有原目标");
          assert.match(after, /^No goal set\.$/mu, "/goal show 必须报告真实核心已无目标");
        }
        assert.equal(pendingInteractions(harness, sessionId).length, 0);
        assert.equal(harness.mock.calls.length, 1, "原生命令控制与状态查询不能误发模型");
      } finally {
        await harness.close();
        await pendingSend?.catch(() => {});
      }
    },
  );
}
