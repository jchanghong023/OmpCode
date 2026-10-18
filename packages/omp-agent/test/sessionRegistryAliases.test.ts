// 冷 alias 来自真实 OMP 命令显示历史和 UUID 关联；不手写会话或派生历史。
// GUI 的唯一侧栏项及 before/after 同根身份迁移继续由现有 identityMigration 验收覆盖。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { zcodeProtocolMethods } from "@zcode/shared";
import { commandAckSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

const listSchema = z.object({ sessions: z.array(z.looseObject({ sessionId: z.string() })) });
const snapshotSchema = z.looseObject({
  session: z.looseObject({ sessionId: z.string(), title: z.string().nullable() }),
  projection: z.looseObject({ sessionId: z.string() }),
  messages: z.array(z.unknown()),
});

async function command(
  harness: RealOmpHarness,
  sessionId: string,
  id: string,
  type: string,
  payload: unknown,
) {
  const ack = commandAckSchema.parse(
    await harness.request("v4/command", {
      commandId: id,
      clientId: "alias-recovery",
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    }),
  );
  assert.equal(ack.status, "accepted", JSON.stringify(ack));
}

async function completedCommand(harness: RealOmpHarness, sessionId: string, commandId: string) {
  const header = await harness.waitUntil(() =>
    [...harness.rows(sessionId).values()].find(
      (row) =>
        row.kind === "turnHeader" &&
        row.sourceCommandId === commandId &&
        ["completedSuccess", "completedInterrupted", "failed"].includes(String(row.state)),
    ),
  );
  assert.equal(header.state, "completedSuccess", JSON.stringify(header));
}

test(
  "真实同根冷恢复：旧逻辑 alias 与 UUID 共享历史，关闭/改名/冷删除保持唯一身份",
  { skip: realOmpSkip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-registry-alias-"));
    let harness: RealOmpHarness | undefined;
    const marker = "ALIAS_NATIVE_JOURNAL_RESPONSE";
    try {
      harness = await startRealOmpHarness({ root, responses: [{ content: [marker] }] });
      // 先通过真实空会话创建取得尚未绑定原生文件的逻辑地址；
      // 同步 firstInput 的 create ACK 可能已经返回稳定 UUID，不能作为临时 alias。
      const draft = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "create-alias-draft",
          clientId: "alias-recovery",
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: "real-e2e-workspace" },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(draft.status, "accepted");
      const alias = z.object({ sessionId: z.string() }).parse(draft.result).sessionId;
      assert.match(alias, /^omp-session-/u);
      await harness.subscribe(alias);
      // 原生命令生成真实 command_output，随后普通模型轮生成真实 journal。
      // 临时 GUI 地址的冷 alias 完全由产品写入，不手写 aliases/store。
      await command(harness, alias, "alias-native-output", "sendText", { text: "/goal show" });
      await completedCommand(harness, alias, "alias-native-output");
      const first = harness;
      const nativeOutput = await harness.waitUntil(() =>
        [...first.rows(alias).values()].find(
          (row) => row.kind === "assistantText" && String(row.text ?? "").trim().length > 0,
        ),
      );
      assert.equal(harness.mock.calls.length, 0, "只读原生命令不应伪装为模型轮");
      await command(harness, alias, "alias-native-prompt", "sendText", {
        text: "Persist the alias conversation.",
      });
      await completedCommand(harness, alias, "alias-native-prompt");
      const persisted = harness;
      await harness.waitUntil(() =>
        [...persisted.rows(alias).values()].find(
          (row) => row.kind === "assistantText" && String(row.text ?? "").includes(marker),
        ),
      );
      const listed = listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
      assert.equal(listed.sessions.length, 1);
      const canonical = z.uuid().parse(listed.sessions[0]!.sessionId);
      assert.notEqual(canonical, alias);
      const originalWorkspace = harness.workspace;
      harness.mock.assertHealthy();
      await harness.close();
      harness = undefined;

      // 关闭旧 adapter 后，以同一调用方根启动全新 adapter/目录进程/会话进程。
      harness = await startRealOmpHarness({ root, responses: [] });
      assert.equal(harness.workspace, originalWorkspace);
      assert.deepEqual(
        listSchema
          .parse(await harness.request(zcodeProtocolMethods.sessionList, {}))
          .sessions.map((session) => session.sessionId),
        [canonical],
      );
      const recovered = harness;
      const snapshots = await Promise.all(
        [canonical, alias].map(async (sessionId) =>
          snapshotSchema.parse(
            await recovered.request(zcodeProtocolMethods.sessionResume, { sessionId }),
          ),
        ),
      );
      for (const [index, id] of [canonical, alias].entries()) {
        assert.equal(snapshots[index]!.session.sessionId, id);
        assert.equal(snapshots[index]!.projection.sessionId, id);
        assert.ok(JSON.stringify(snapshots[index]!.messages).includes(marker));
        await harness.subscribe(id);
        // subscribe ACK 先于 initial 通知；等待真实冷行而非假定响应即已投影。
        await harness.waitUntil(() => {
          const observed = [...recovered.rows(id).values()];
          return (
            observed.some(
              (row) => row.kind === "assistantText" && String(row.text ?? "").includes(marker),
            ) &&
            observed.some((row) => row.kind === "assistantText" && row.text === nativeOutput.text)
          );
        });
        const rows: Record<string, unknown>[] = [...recovered.rows(id).values()];
        assert.equal(
          rows.filter(
            (row) => row.kind === "assistantText" && String(row.text ?? "").includes(marker),
          ).length,
          1,
        );
        assert.ok(
          rows.some((row) => row.kind === "assistantText" && row.text === nativeOutput.text),
          "原生命令显示事实也须冷恢复",
        );
      }
      assert.deepEqual(
        listSchema
          .parse(await harness.request(zcodeProtocolMethods.sessionList, {}))
          .sessions.map((session) => session.sessionId),
        [canonical],
        "两个公开地址不得产生第二条列表项",
      );
      await command(harness, alias, "rename-via-alias", "renameSession", {
        title: "Recovered alias title",
      });
      const renamed = snapshotSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionRead, { sessionId: canonical }),
      );
      assert.equal(renamed.session.title, "Recovered alias title");
      await harness.request(zcodeProtocolMethods.sessionClose, { sessionId: alias });
      const reopened = snapshotSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionResume, { sessionId: canonical }),
      );
      assert.equal(reopened.session.title, "Recovered alias title");
      assert.ok(JSON.stringify(reopened.messages).includes(marker));
      await harness.request(zcodeProtocolMethods.sessionClose, { sessionId: canonical });
      await command(harness, alias, "delete-cold-alias", "deleteSession", {});
      for (const sessionId of [canonical, alias]) {
        const response = await harness.rawRequest(zcodeProtocolMethods.sessionResume, {
          sessionId,
        });
        assert.equal(z.object({ code: z.number() }).parse(response.error).code, -32004);
      }
      assert.deepEqual(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions,
        [],
      );
      assert.equal(harness.mock.calls.length, 0, "冷恢复/改名/关闭/删除不应重新提交历史输入");
      harness.mock.assertHealthy();
      await harness.close();
      harness = undefined;

      harness = await startRealOmpHarness({ root, responses: [] });
      assert.deepEqual(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions,
        [],
        "第三个 adapter 不得复活已永久删除的真实历史",
      );
      for (const sessionId of [canonical, alias]) {
        const response = await harness.rawRequest(zcodeProtocolMethods.sessionRead, { sessionId });
        assert.equal(z.object({ code: z.number() }).parse(response.error).code, -32004);
      }
      harness.mock.assertHealthy();
    } finally {
      try {
        await harness?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
