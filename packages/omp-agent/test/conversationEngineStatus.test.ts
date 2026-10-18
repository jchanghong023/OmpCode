import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  commandAckSchema,
  conversationSnapshotSchema,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

async function submit(
  harness: RealOmpHarness,
  sessionId: string,
  commandId: string,
  type: "sendText" | "stop" | "setAutoDrain",
  payload: unknown,
) {
  // setAutoDrain 是 CAS 命令（协议层 COMMANDS_REQUIRING_BASE_REVISION）：信封缺 baseRevision 会被
  // -32602「CAS commands require baseRevision and baseLogEpoch」直接拒绝，所以提交前从订阅投影取
  // 当前 revision；投影仍在推进时按 ACK 的 revisionAtDecision 收敛重试（与
  // adapterRuntime.e2e.test.ts 的 setFollowupMode 同构）。重试换 commandId：幂等表按
  // sessionId:commandId 缓存 ACK，沿用旧 ID 只会拿回同一条 stale 回包。
  const cas = COMMANDS_REQUIRING_BASE_REVISION.has(type);
  let baseRevision = cas
    ? conversationSnapshotSchema.parse(harness.state(sessionId)).revision
    : undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ack = commandAckSchema.parse(
      await harness.request("v4/command", {
        commandId: attempt === 0 ? commandId : `${commandId}-retry-${attempt}`,
        clientId: "queue-boundary",
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        ...(baseRevision === undefined ? {} : { baseRevision }),
      }),
    );
    if (ack.status === "accepted") return ack;
    if (!cas) assert.fail(`命令未被接受: ${JSON.stringify(ack)}`);
    assert.equal(ack.status, "stale", `CAS 命令只接受 stale 重试: ${JSON.stringify(ack)}`);
    baseRevision = ack.revisionAtDecision;
  }
  assert.fail(`CAS 命令 ${type} 连续 stale，未收敛到 accepted`);
}

type QueueModelContext = {
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
};

for (const ending of ["success", "failure", "stop", "exit"] as const) {
  test(
    `真实应用queue在${ending}后保持独立消费或全部撤销，冷恢复不重放等待输入`,
    { skip: realOmpSkip },
    async () => {
      const warmupInput = `queue-boundary-${ending}-warmup`;
      const activeInput = `queue-boundary-${ending}-active`;
      const waitingInput = `queue-boundary-${ending}-waiting`;
      const recoveredInput = `queue-boundary-${ending}-recovered`;
      const waitingIds = [0, 1, 2].map((index) => `queue-${ending}-${index}`);
      // exit 变体先跑完一个真实回合让 omp 落盘会话 JSONL，再在下一个 held 回合里杀核（原因见
      // create 前的懒落盘说明）；其余变体直接进入 held 回合。
      const warmupTurn = ending === "exit";
      let warmupCalls = 0;
      let activeCalls = 0;
      let queuedCalls = 0;
      let recoveredCalls = 0;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const harness = await startRealOmpHarness({
        async handler(context: QueueModelContext, options: { signal?: AbortSignal }) {
          const user = [...context.messages].reverse().find((message) => message.role === "user");
          assert.ok(user);
          const text =
            typeof user.content === "string"
              ? user.content
              : user.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n");
          if (text.includes(warmupInput)) {
            assert.equal(++warmupCalls, 1, "落盘回合不得隐式重发");
            return { content: ["QUEUE_BOUNDARY_WARMUP_DONE"] };
          }
          if (text.includes(activeInput)) {
            assert.equal(++activeCalls, 1, "原轮不得隐式重发");
            const signal = options.signal;
            assert.ok(signal, "真实HTTP请求必须可取消");
            let aborted!: () => void;
            await Promise.race([
              released,
              new Promise<void>((resolve) => {
                aborted = () => resolve();
                signal.addEventListener("abort", aborted, { once: true });
                if (signal.aborted) resolve();
              }),
            ]);
            signal.removeEventListener("abort", aborted);
            return ending === "failure"
              ? {
                  content: [],
                  stopReason: "error",
                  errorMessage: "401 queue-boundary original failure",
                }
              : { content: [ending === "success" ? "QUEUE_ACTIVE_DONE" : "STALE_OLD_RUN_OUTPUT"] };
          }
          if (text.includes(waitingInput)) {
            assert.equal(ending, "success", "失败、stop或退出不能执行已接纳的等待输入");
            assert.ok(++queuedCalls <= 3, "同文等待输入不能重复执行");
            return { content: [`QUEUE_REPLY_${queuedCalls}`] };
          }
          assert.ok(text.includes(recoveredInput), `Unexpected model input: ${text}`);
          assert.equal(++recoveredCalls, 1);
          return { content: ["QUEUE_NEW_RUN_DONE"] };
        },
      });
      try {
        // omp 普通会话是懒落盘：首个 assistant 消息（或显式 ensureOnDisk）之前不写会话 JSONL
        // （上游 docs/session.md「A new ordinary session remains memory-only until it contains an
        // assistant message」；session-manager.ts 的 lazy gate），RPC 面也没有强制落盘的接口。
        // 首轮中途 SIGKILL 会让该会话在磁盘上从未存在：冷恢复按事实拒绝 -32004（
        // `--resume <缺失文件>` 在 omp 侧直接 exit 1「Session not found」），无法验证
        // 「冷恢复不重放等待输入」。所以 exit 变体先完成一个真实回合跨过落盘门（该回合的
        // 落盘是同步整文件重写，adapter 看到终态时 JSONL 已在盘上），再在下一个 held 回合杀核。
        const sessionId = await harness.create(
          `queue-boundary-${ending}`,
          warmupTurn ? warmupInput : activeInput,
        );
        if (warmupTurn) {
          await harness.waitUntil(
            () => warmupCalls === 1 && harness.terminal(sessionId)?.state === "completedSuccess",
          );
          await submit(harness, sessionId, `queue-boundary-${ending}-active`, "sendText", {
            text: activeInput,
          });
        }
        await harness.waitUntil(() => activeCalls === 1);
        assert.equal(
          conversationSnapshotSchema.parse(harness.state(sessionId)).config.followupMode,
          "queue",
        );
        for (const commandId of waitingIds) {
          const ack = await submit(harness, sessionId, commandId, "sendText", {
            text: waitingInput,
          });
          assert.ok(ack.result && "delivery" in ack.result);
          assert.equal(ack.result.delivery, "queue");
        }
        await harness.waitUntil(() => {
          const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
          return snapshot.queue.items.length === 3;
        });
        const waiting = conversationSnapshotSchema.parse(harness.state(sessionId));
        assert.deepEqual(
          waiting.queue.items.map((item) => item.sourceCommandId),
          waitingIds,
        );
        assert.equal(new Set(waiting.queue.items.map((item) => item.queueItemId)).size, 3);
        assert.equal(warmupCalls, warmupTurn ? 1 : 0);
        assert.equal(harness.mock.calls.length, 1 + warmupCalls, "接纳队列不能提前发模型请求");

        if (ending === "stop") {
          await submit(harness, sessionId, "queue-stop", "stop", {});
        } else if (ending === "exit") {
          const core = await harness.waitUntil(() =>
            harness.coreLifecycle.find(
              (record) => record.event === "omp_core_spawned" && record.sessionless === false,
            ),
          );
          // 只终止此隔离harness实际启动并记录的会话OMP，不触碰日常进程。
          process.kill(z.number().int().positive().parse(core.peerPid), "SIGKILL");
        } else {
          release();
        }
        const phase =
          ending === "success"
            ? "completedSuccess"
            : ending === "stop"
              ? "completedInterrupted"
              : "error";
        await harness.waitUntil(() => {
          const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
          return snapshot.control.phase === phase && snapshot.queue.items.length === 0;
        });
        release();
        const live = conversationSnapshotSchema.parse(harness.state(sessionId));
        const liveRows = [...harness.rows(sessionId).values()];
        const queuedHeaders = liveRows.filter(
          (row) => row.kind === "turnHeader" && waitingIds.includes(String(row.sourceCommandId)),
        );
        assert.deepEqual(
          queuedHeaders.map((row) => row.sourceCommandId),
          waitingIds,
        );
        assert.ok(
          queuedHeaders.every(
            (row) =>
              row.state ===
              (ending === "success"
                ? "completedSuccess"
                : ending === "stop"
                  ? "completedInterrupted"
                  : "failed"),
          ),
        );
        const expectedCalls = (ending === "success" ? 4 : 1) + warmupCalls;
        assert.equal(harness.mock.calls.length, expectedCalls);
        if (ending === "failure") {
          assert.match(
            live.control.lastError?.message ?? "",
            /401 queue-boundary original failure/u,
          );
        } else if (ending === "exit") {
          assert.equal(live.control.lastError?.code, "omp_process_exit");
        } else {
          assert.equal(live.control.lastError, null);
        }
        for (let index = 0; index < 3 && ending === "success"; index++) {
          const input = liveRows.find(
            (row) => row.kind === "userInput" && row.sourceCommandId === waitingIds[index],
          );
          assert.ok(input);
          assert.deepEqual(
            liveRows
              .filter((row) => row.kind === "assistantText" && row.turnId === input.turnId)
              .map((row) => row.text),
            [`QUEUE_REPLY_${index + 1}`],
            "三个同文输入必须各消费一次并关联自己的唯一完整输出",
          );
        }
        const web = v4ConversationSubscribeResultSchema.parse(
          await harness.request("v4/conversation/subscribe", {
            topic: `conversation/${sessionId}`,
            connectionId: `queue-${ending}-web`,
            clientMode: "web-remote-replayable",
          }),
        );
        const replay = await harness.waitUntil(() =>
          harness
            .conversationFrames(sessionId)
            .find(
              (frame) =>
                frame.subscriptionId === web.ack.subscriptionId &&
                frame.payload.kind === "snapshot",
            ),
        );
        assert.equal(replay.payload.kind, "snapshot");
        if (replay.payload.kind !== "snapshot") throw new Error("missing queue replay snapshot");
        assert.deepEqual(replay.payload.snapshot.control, live.control);
        assert.deepEqual(replay.payload.snapshot.queue, live.queue);
        assert.deepEqual(replay.payload.snapshot.rows.window, liveRows);

        const listed = z
          .object({
            sessions: z.array(z.object({ sessionId: z.uuid() })).length(1),
          })
          .parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
        const canonical = listed.sessions[0]!.sessionId;
        await harness.request(zcodeProtocolMethods.sessionClose, { sessionId: canonical });
        await harness.request(zcodeProtocolMethods.sessionResume, { sessionId: canonical });
        const coldSubscription = v4ConversationSubscribeResultSchema.parse(
          await harness.request("v4/conversation/subscribe", {
            topic: `conversation/${canonical}`,
            connectionId: `queue-${ending}-cold`,
            clientMode: "desktop-continuous",
          }),
        );
        const coldFrame = await harness.waitUntil(() =>
          harness
            .conversationFrames(canonical)
            .find(
              (frame) =>
                frame.subscriptionId === coldSubscription.ack.subscriptionId &&
                frame.payload.kind === "snapshot",
            ),
        );
        assert.equal(coldFrame.payload.kind, "snapshot");
        if (coldFrame.payload.kind !== "snapshot") throw new Error("missing cold queue snapshot");
        const cold = coldFrame.payload.snapshot;
        assert.deepEqual(cold.queue.items, []);
        if (ending !== "success") {
          assert.ok(
            ![...harness.rows(canonical).values()].some(
              (row) => row.kind === "userInput" && String(row.text).includes(waitingInput),
            ),
            "冷恢复不能将未执行队列伪装为持久历史",
          );
        }
        assert.equal(harness.mock.calls.length, expectedCalls, "冷恢复本身不得执行模型");
        await submit(harness, canonical, "queue-new-run", "sendText", { text: recoveredInput });
        await harness.waitUntil(() => {
          const snapshot = conversationSnapshotSchema.parse(harness.state(canonical));
          return (
            snapshot.control.phase === "completedSuccess" &&
            [...harness.rows(canonical).values()].some(
              (row) =>
                row.kind === "assistantText" &&
                row.text === "QUEUE_NEW_RUN_DONE" &&
                row.state === "complete",
            )
          );
        });
        const recovered = conversationSnapshotSchema.parse(harness.state(canonical));
        assert.equal(recovered.control.lastError, null);
        assert.deepEqual(recovered.queue.items, []);
        assert.equal(harness.mock.calls.length, expectedCalls + 1);
        assert.ok(
          ![...harness.rows(canonical).values()].some((row) => row.text === "STALE_OLD_RUN_OUTPUT"),
        );
        assert.equal(activeCalls, 1);
        assert.equal(queuedCalls, ending === "success" ? 3 : 0);
        assert.equal(recoveredCalls, 1);
      } finally {
        release();
        await harness.close();
      }
    },
  );
}

test(
  "真实v4 autoDrain暂停保留队列，恢复与busy重复恢复只按FIFO逐项消费一次",
  { skip: realOmpSkip },
  async () => {
    const inputs = [0, 1, 2, 3].map((index) => `queue-auto-drain-input-${index}`);
    const commandIds = [1, 2, 3].map((index) => `queue-auto-drain-${index}`);
    const requested: number[] = [];
    const barriers = inputs.map(() => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held, release };
    });
    const harness = await startRealOmpHarness({
      async handler(context: QueueModelContext) {
        const user = [...context.messages].reverse().find((message) => message.role === "user");
        assert.ok(user);
        const text =
          typeof user.content === "string"
            ? user.content
            : user.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
        const index = inputs.findIndex((input) => text.includes(input));
        assert.ok(index >= 0, `Unexpected autoDrain model input: ${text}`);
        assert.equal(
          index,
          requested.length,
          "真实HTTP必须按FIFO各执行一次，不得重复队首或额外派发",
        );
        requested.push(index);
        await barriers[index]!.held;
        return { content: [`QUEUE_AUTO_DRAIN_REPLY_${index}`] };
      },
    });
    try {
      const sessionId = await harness.create("queue-auto-drain", inputs[0]!);
      await harness.waitUntil(() => requested.length === 1);
      for (const [index, commandId] of commandIds.entries()) {
        const ack = await submit(harness, sessionId, commandId, "sendText", {
          text: inputs[index + 1],
        });
        assert.ok(ack.result && "delivery" in ack.result);
        assert.equal(ack.result.delivery, "queue");
      }
      await harness.waitUntil(
        () => conversationSnapshotSchema.parse(harness.state(sessionId)).queue.items.length === 3,
      );
      await submit(harness, sessionId, "queue-auto-drain-pause", "setAutoDrain", {
        autoDrain: false,
      });
      await harness.waitUntil(
        () => !conversationSnapshotSchema.parse(harness.state(sessionId)).queue.autoDrain,
      );
      const pausedBusy = conversationSnapshotSchema.parse(harness.state(sessionId));
      assert.equal(pausedBusy.control.canStop, true, "暂停自动消费不得停止当前真实请求");
      assert.deepEqual(
        pausedBusy.queue.items.map((item) => item.sourceCommandId),
        commandIds,
      );
      assert.equal(harness.mock.calls.length, 1);
      barriers[0]!.release();
      await harness.waitUntil(() => {
        const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
        return (
          snapshot.control.phase === "completedSuccess" &&
          [...harness.rows(sessionId).values()].some(
            (row) =>
              row.kind === "assistantText" &&
              row.text === "QUEUE_AUTO_DRAIN_REPLY_0" &&
              row.state === "complete",
          )
        );
      });
      const pausedDone = conversationSnapshotSchema.parse(harness.state(sessionId));
      assert.equal(pausedDone.queue.autoDrain, false, "accepted ACK不能冒充实际暂停");
      assert.deepEqual(
        pausedDone.queue.items.map((item) => item.sourceCommandId),
        commandIds,
      );
      assert.deepEqual(requested, [0]);
      assert.equal(harness.mock.calls.length, 1, "真实成功终态仍暂停，三个等待项不得发HTTP");

      await submit(harness, sessionId, "queue-auto-drain-resume", "setAutoDrain", {
        autoDrain: true,
      });
      for (let index = 1; index <= 3; index++) {
        await harness.waitUntil(() => {
          const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
          return (
            requested.length === index + 1 &&
            snapshot.queue.items.length === 3 - index &&
            snapshot.queue.autoDrain &&
            snapshot.control.canStop
          );
        });
        if (index === 1) {
          // 队首HTTP仍held时，另一个公开true只能武装后续消费，不能再派发下一项。
          await submit(harness, sessionId, "queue-auto-drain-resume-busy", "setAutoDrain", {
            autoDrain: true,
          });
        }
        const busy = conversationSnapshotSchema.parse(harness.state(sessionId));
        assert.equal(busy.queue.autoDrain, true);
        assert.equal(busy.control.canStop, true);
        assert.deepEqual(
          busy.queue.items.map((item) => item.sourceCommandId),
          commandIds.slice(index),
        );
        assert.deepEqual(
          requested,
          Array.from({ length: index + 1 }, (_, value) => value),
        );
        assert.equal(harness.mock.calls.length, index + 1, "held请求期间busy true不能提前发下一项");
        // 引擎在接纳等待项时就为它建 turnHeader+userInput 行（queuedTurnReconcile.beginUserTurnOf），
        // 且 queuedInputProjection.publishQueuedInputsOf 正是靠这些行派生 queue.items（createdAtSeq/clientId/
        // attachments 只在行上）；等待中的轮由 UI 剥离（packages/ui/src/v4/OmpQueuedInputRows.ts
        // 「OMP 已接受但未消费的输入只在队列面板展示」）。复现证据：三项都还在 queue.items、只有一次 HTTP 时，
        // 快照里已有三条 userInput 行。所以「有行」不等于「已消费」，行数只能证明接纳唯一且 FIFO，
        // 消费事实由 queue.items 前缀（上一处）与真实 HTTP（requested/mock.calls）承担。
        const inputRows = [...harness.rows(sessionId).values()].filter(
          (row) => row.kind === "userInput" && commandIds.includes(String(row.sourceCommandId)),
        );
        assert.deepEqual(
          inputRows.map((row) => row.sourceCommandId),
          commandIds,
          "每个已接纳输入恰一行，等待中也不得重复建行、缺项或乱序",
        );
        assert.deepEqual(
          inputRows.map((row) => row.text),
          inputs.slice(1),
          "行文本按接纳顺序对应各自输入",
        );
        barriers[index]!.release();
      }
      await harness.waitUntil(() => {
        const snapshot = conversationSnapshotSchema.parse(harness.state(sessionId));
        return (
          snapshot.control.phase === "completedSuccess" &&
          [...harness.rows(sessionId).values()].some(
            (row) =>
              row.kind === "assistantText" &&
              row.text === "QUEUE_AUTO_DRAIN_REPLY_3" &&
              row.state === "complete",
          )
        );
      });
      const done = conversationSnapshotSchema.parse(harness.state(sessionId));
      assert.equal(done.queue.autoDrain, true);
      assert.deepEqual(done.queue.items, []);
      assert.equal(done.control.lastError, null);
      assert.deepEqual(requested, [0, 1, 2, 3]);
      assert.equal(harness.mock.calls.length, 4, "原轮加三个等待项，不得有第四次队列模型请求");
      const rows = [...harness.rows(sessionId).values()];
      const headers = rows.filter(
        (row) => row.kind === "turnHeader" && commandIds.includes(String(row.sourceCommandId)),
      );
      assert.deepEqual(
        headers.map((row) => row.sourceCommandId),
        commandIds,
      );
      assert.ok(headers.every((row) => row.state === "completedSuccess"));
      for (const [index, commandId] of commandIds.entries()) {
        const consumed = rows.filter(
          (row) => row.kind === "userInput" && row.sourceCommandId === commandId,
        );
        assert.equal(consumed.length, 1, "每个commandId只消费一次");
        assert.deepEqual(
          rows
            .filter((row) => row.kind === "assistantText" && row.turnId === consumed[0]!.turnId)
            .map((row) => ({ text: row.text, state: row.state })),
          [{ text: `QUEUE_AUTO_DRAIN_REPLY_${index + 1}`, state: "complete" }],
          "每项FIFO输入关联自己的唯一完整输出",
        );
      }
    } finally {
      for (const barrier of barriers) barrier.release();
      await harness.close();
    }
  },
);
