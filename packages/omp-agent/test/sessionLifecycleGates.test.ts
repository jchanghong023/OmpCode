// 生命周期验收只驱动真实 adapter/OMP；模型响应来自独占回环服务。
// 不再注入冷读取/销毁时序或伪造目录删除结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { zcodeProtocolMethods } from "@zcode/shared";
import { commandAckSchema } from "@zcode/shared/zcode-protocol-v4";
import { realOmpSkip, startRealOmpHarness } from "./fixtures/realOmpHarness.js";
import { SessionRegistryGates } from "../src/app/sessionRegistryGates.js";

const listSchema = z.object({
  sessions: z.array(z.looseObject({ sessionId: z.string(), title: z.string().nullable() })),
});
const snapshotSchema = z.looseObject({
  session: z.looseObject({ sessionId: z.string(), title: z.string().nullable() }),
  projection: z.looseObject({ sessionId: z.string() }),
  messages: z.array(z.unknown()),
});

test("纯登记门算法：删除回滚、关闭窗口与 dispose 检查所有身份", () => {
  const gates = new SessionRegistryGates({
    engines: new Map(),
    getEngine: () => null,
  });
  const alias = "omp-session-gate-alias";
  const canonical = "00000000-0000-4000-8000-000000000001";
  assert.equal(gates.canResume(alias, canonical), true);
  gates.markDeleted(canonical);
  assert.equal(gates.canResume(alias, canonical), false);
  gates.rollbackDeleted(canonical);
  assert.equal(gates.canResume(alias, canonical), true);
  gates.markClosing(alias);
  assert.equal(gates.canResume(canonical, alias), false);
  gates.endClosing(alias);
  assert.equal(gates.canResume(canonical, alias), true);
  gates.beginDispose();
  assert.equal(gates.canResume(alias, canonical), false);
  assert.equal(gates.canResume("new-session"), false);
});

test(
  "真实生命周期：关闭保留历史，热/冷改名落盘，永久删除不复活",
  { skip: realOmpSkip },
  async () => {
    const marker = "LIFECYCLE_SAVED_RESPONSE";
    const harness = await startRealOmpHarness({ responses: [{ content: [marker] }] });
    try {
      const temporaryId = await harness.create("lifecycle", "Save this lifecycle conversation.");
      await harness.waitUntil(() => harness.terminal(temporaryId));
      assert.equal(harness.terminal(temporaryId)?.state, "completedSuccess");
      const listed = listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
      assert.equal(listed.sessions.length, 1);
      const sessionId = z.uuid().parse(listed.sessions[0]!.sessionId);

      const command = async (
        id: string,
        type: "renameSession" | "deleteSession",
        payload: unknown,
      ) =>
        commandAckSchema.parse(
          await harness.request("v4/command", {
            commandId: id,
            clientId: "lifecycle",
            sessionId,
            type,
            payload,
            issuedAt: Date.now(),
          }),
        );
      assert.equal(
        (await command("rename-loaded", "renameSession", { title: "Loaded lifecycle" })).status,
        "accepted",
      );
      assert.deepEqual(await harness.request(zcodeProtocolMethods.sessionClose, { sessionId }), {
        closed: true,
      });
      // 此时没有已加载引擎：改名由真实目录进程处理，不能靠投影写标题冒充成功。
      assert.equal(
        (await command("rename-cold", "renameSession", { title: "Cold lifecycle" })).status,
        "accepted",
      );
      const resumed = snapshotSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionResume, { sessionId }),
      );
      assert.equal(resumed.session.sessionId, sessionId);
      assert.equal(resumed.projection.sessionId, sessionId);
      assert.equal(resumed.session.title, "Cold lifecycle");
      assert.ok(
        JSON.stringify(resumed.messages).includes(marker),
        "关闭和冷改名不能丢失真实持久消息",
      );
      assert.equal(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions
          .length,
        1,
      );

      assert.equal((await command("delete-loaded", "deleteSession", {})).status, "accepted");
      assert.deepEqual(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions,
        [],
      );
      const duplicate = await harness.rawRequest("v4/command", {
        commandId: "delete-again",
        clientId: "lifecycle",
        sessionId,
        type: "deleteSession",
        payload: {},
        issuedAt: Date.now(),
      });
      assert.equal(z.object({ code: z.number() }).parse(duplicate.error).code, -32004);
      for (const method of [zcodeProtocolMethods.sessionResume, zcodeProtocolMethods.sessionRead]) {
        const response = await harness.rawRequest(method, { sessionId });
        assert.equal(z.object({ code: z.number() }).parse(response.error).code, -32004);
      }
      assert.deepEqual(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions,
        [],
      );
      harness.mock.assertHealthy();
    } finally {
      await harness.close();
    }
  },
);

test("真实删除失败不影响另一条仍存在的会话", { skip: realOmpSkip }, async () => {
  const marker = "LIFECYCLE_SURVIVOR";
  const harness = await startRealOmpHarness({ responses: [{ content: [marker] }] });
  try {
    const temporaryId = await harness.create("delete-failure", "Keep this conversation available.");
    await harness.waitUntil(() => harness.terminal(temporaryId));
    assert.equal(harness.terminal(temporaryId)?.state, "completedSuccess");
    const listed = listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
    assert.equal(listed.sessions.length, 1);
    const sessionId = listed.sessions[0]!.sessionId;
    await harness.request(zcodeProtocolMethods.sessionClose, { sessionId });
    const rejected = await harness.rawRequest("v4/command", {
      commandId: "delete-unknown",
      clientId: "lifecycle",
      sessionId: "00000000-0000-4000-8000-000000000001",
      type: "deleteSession",
      payload: {},
      issuedAt: Date.now(),
    });
    assert.equal(z.object({ code: z.number() }).parse(rejected.error).code, -32004);
    const resumed = snapshotSchema.parse(
      await harness.request(zcodeProtocolMethods.sessionResume, { sessionId }),
    );
    assert.ok(JSON.stringify(resumed.messages).includes(marker));
    assert.deepEqual(
      listSchema
        .parse(await harness.request(zcodeProtocolMethods.sessionList, {}))
        .sessions.map((session) => session.sessionId),
      [sessionId],
    );
    harness.mock.assertHealthy();
  } finally {
    await harness.close();
  }
});
