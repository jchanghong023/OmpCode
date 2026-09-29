import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  createZCodeTaskIndexSyncer,
  type ZCodeTaskIndexSyncer,
} from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import type { SessionsIndexTopicWireCandidate } from "@zcode/shared";

/**
 * 修复回归（评审 P3）：applySessionsIndexFrame 原实现对任何 session.upserted 都先
 * 无条件清空 pendingRekeyFrom，UUID 形状判断在其后；中途到达的非匹配 upserted 会
 * 无谓丢弃 rekey 候选，temp 任务行不随迁、被下轮快照对账整行标 deleted。
 * 本测试验证：removed(temp) 与 upserted(uuid) 之间插入其他会话的 upserted 时，
 * pending 不被误清，uuid 到达后 rekey 仍成功建立。
 */

type WireHandler = (wire: SessionsIndexTopicWireCandidate) => void;

function wireFrame(
  topic: string,
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
  payload: Record<string, unknown>,
): SessionsIndexTopicWireCandidate {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `frame-${toSeq}`,
    logicalFrameOrdinal: toSeq,
    topic,
    subscriptionId,
    frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: Date.now(), payload },
  } as unknown as SessionsIndexTopicWireCandidate;
}

function summary(input: {
  sessionId: string;
  phase: "completedSuccess" | "running";
  title?: string;
}) {
  return {
    sessionId: input.sessionId,
    workspaceId: "ws",
    title: input.title ?? `任务 ${input.sessionId}`,
    phase: input.phase,
    sessionEnded: input.phase !== "running",
    hasBackgroundWork: false,
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("omp 临时会话 rekey：中间插入的非匹配 upserted 不丢弃 rekey 候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-rekey-delta-"));
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const workspacePath = join(root, "workspace");
  const tempId = "omp-session-temp";
  const otherTempId = "omp-session-other";
  const uuidId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  const topic = `sessions-index/${workspacePath}`;
  const subscriptionId = "sub-1";

  const indexHandlers: WireHandler[] = [];
  const agentService = {
    async subscribeSessionsIndexV4() {
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" } };
    },
    async unsubscribeSessionsIndexV4() {},
    onDynamicSessionsIndexFrame() {
      return (handler: WireHandler) => {
        indexHandlers.push(handler);
        return { dispose: () => {} };
      };
    },
    async subscribeWorkspaceConfigV4() {
      return { ack: { subscriptionId: "cfg-1", mode: "snapshot", logEpoch: "epoch-1" } };
    },
    async unsubscribeWorkspaceConfigV4() {},
    onDynamicWorkspaceConfigFrame() {
      return () => ({ dispose: () => {} });
    },
    async readSession() {
      throw new Error("existing-only 回源在测试中不应被真实满足");
    },
  } as unknown as IZCodeAgentService;

  let syncer: ZCodeTaskIndexSyncer | null = null;
  try {
    syncer = createZCodeTaskIndexSyncer({ agentService, taskIndexRepo: repo });
    syncer.ensureWorkspaceSubscription({ workspacePath });
    await tick();
    assert.equal(indexHandlers.length, 1, "sessions-index 帧监听应已安装");
    const deliver = (fromSeq: number, toSeq: number, payload: Record<string, unknown>) =>
      indexHandlers[0](wireFrame(topic, subscriptionId, fromSeq, toSeq, payload));

    // 1) initial snapshot：temp 终态会话进入基线并静默补行。
    deliver(0, 1, {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "ws",
        logEpoch: "epoch-1",
        sessions: [summary({ sessionId: tempId, phase: "completedSuccess" })],
      },
    });
    await tick();
    assert.ok(
      await repo.getTaskMeta({ workspacePath, taskId: tempId }),
      "基线 seed 应为 temp 会话建立 task 行",
    );

    // 2) temp removed：进入 rekey 挂起态。
    deliver(1, 2, { kind: "deltas", deltas: [{ op: "session.removed", sessionId: tempId }] });

    // 3) 中途插入其他会话的非匹配 upserted（修复前会在此清空 pending）。
    deliver(2, 3, {
      kind: "deltas",
      deltas: [
        { op: "session.upserted", session: summary({ sessionId: otherTempId, phase: "running" }) },
      ],
    });

    // 4) uuid upserted：rekey 应照常发生，temp 行迁移到 uuid 且产品壳状态随迁。
    deliver(3, 4, {
      kind: "deltas",
      deltas: [
        {
          op: "session.upserted",
          session: summary({
            sessionId: uuidId,
            phase: "completedSuccess",
            title: "任务 omp-session-temp",
          }),
        },
      ],
    });
    await tick();

    assert.equal(
      await repo.getTaskMeta({ workspacePath, taskId: tempId }),
      null,
      "rekey 后旧 temp 行应已迁移",
    );
    const migrated = await repo.getTaskMeta({ workspacePath, taskId: uuidId });
    assert.ok(migrated, "rekey 后 uuid 行应存在");
    assert.equal(migrated.taskId, uuidId);
  } finally {
    syncer?.disposeAll();
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
