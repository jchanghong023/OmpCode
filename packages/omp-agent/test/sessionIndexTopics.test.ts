import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  sessionsIndexTopicWireFrameSchema,
  type SessionSummary,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createOmpStore, ompCommandOutputsRoot } from "../src/adapters/ompStore.js";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpDirectoryGatewayPort } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

for (const failureSource of ["native", "derived"] as const) {
  test(`F013: ${failureSource} readdir 失败保留全部摘要，恢复后才对账标题及真实删除`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "omp-index-scan-failure-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const env = {
      OMP_CONFIG_ROOT: join(root, "omp"),
      ZCODE_HOME: join(root, "ompcode"),
      XDG_DATA_HOME: "",
    };
    const sessionDir = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
    await mkdir(sessionDir, { recursive: true });
    const aPath = join(sessionDir, "2026-10-09T00-00-00-000Z_cold-a.jsonl");
    const bPath = join(sessionDir, "2026-10-09T00-00-00-001Z_cold-b.jsonl");
    const journal = (id: string, name: string) =>
      `${JSON.stringify({ type: "title", title: name })}\n${JSON.stringify({ type: "session", id })}\n`;
    await writeFile(aPath, journal("cold-a", "old title"));
    await writeFile(bPath, journal("cold-b", "other title"));
    const store = createOmpStore(env);
    const frames: SessionsIndexTopicFrame[] = [];
    const gateway: HostGateway = {
      emitFrame(raw) {
        const wire = sessionsIndexTopicWireFrameSchema.parse(raw);
        assert.equal(wire.kind, "complete");
        if (wire.kind === "complete") frames.push(wire.frame);
      },
      requestUserInput: async () => ({ action: "cancel" }),
    };
    const failurePath = failureSource === "native" ? sessionDir : ompCommandOutputsRoot(env);
    const parked = `${sessionDir}-parked`;
    const directory: OmpDirectoryGatewayPort = {
      ...createDirectoryStub(),
      async sendDirectory(command) {
        assert.equal(command.type, "rename_session");
        // 真正修改隔离 journal，再让生产 store 的下一次 readdir 遭遇非 ENOENT 错误。
        await writeFile(aPath, journal("cold-a", "new title"));
        if (failureSource === "native") await rename(sessionDir, parked);
        else await mkdir(dirname(failurePath), { recursive: true });
        await writeFile(failurePath, "not a directory");
        return { success: true };
      },
    };
    const registry = new SessionRegistry({
      store,
      gateway,
      directory,
      ompFactory: {
        create() {
          throw new Error("scan must not launch omp");
        },
      },
    });
    context.after(() => registry.dispose());
    const loaded = await registry.createSession({
      sessionId: "omp-session-loaded",
      workspaceId: "bound-workspace",
      workspacePath: homedir(),
    });
    loaded.projection.beginUserTurn({
      text: "loaded",
      inputId: "loaded-input",
      sourceCommandId: "loaded-command",
      clientId: "test",
    });
    registry.upsertEngineSummary(loaded);
    const subscription = await registry.subscribeSessionsIndex({
      workspaceId: "bound-workspace",
      workspacePath: homedir(),
      connectionId: "test",
    });
    const snapshot = () => {
      registry.resyncIndexOrConfig(subscription.subscriptionId, null, true);
      const payload = frames.at(-1)!.payload;
      assert.equal(payload.kind, "snapshot");
      if (payload.kind !== "snapshot") throw new Error("expected index snapshot");
      return payload.snapshot.sessions;
    };
    const before: SessionSummary[] = snapshot();
    assert.deepEqual(
      before.map((session) => session.sessionId).sort(),
      ["cold-a", "cold-b", loaded.sessionId].sort(),
    );
    frames.length = 0;
    await assert.rejects(registry.renameColdSession("cold-a", "new title"), (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      assert.ok(code && code !== "ENOENT", String(error));
      return true;
    });
    assert.equal(frames.length, 0, "失败扫描不能发布 upsert、removed 或假 empty");
    assert.deepEqual(snapshot(), before, "冷会话和已加载会话的摘要都保留");
    const preservedB =
      failureSource === "native" ? join(parked, "2026-10-09T00-00-00-001Z_cold-b.jsonl") : bPath;
    assert.match(await readFile(preservedB, "utf8"), /cold-b/);
    await rm(failurePath);
    if (failureSource === "native") await rename(parked, sessionDir);
    await rm(bPath);
    frames.length = 0;
    await registry.onProjectSessionsChanged();
    const deltas = frames.flatMap((frame) =>
      frame.payload.kind === "deltas" ? frame.payload.deltas : [],
    );
    assert.deepEqual(
      deltas.filter((delta) => delta.op === "session.removed"),
      [{ op: "session.removed", sessionId: "cold-b" }],
    );
    const refreshed = deltas.find(
      (delta) => delta.op === "session.upserted" && delta.session.sessionId === "cold-a",
    );
    assert.equal(
      refreshed?.op === "session.upserted" ? refreshed.session.title : undefined,
      "new title",
    );
    const after = snapshot();
    assert.deepEqual(
      after.map((session) => session.sessionId).sort(),
      ["cold-a", loaded.sessionId].sort(),
    );
    assert.deepEqual(
      after.find((session) => session.sessionId === loaded.sessionId),
      before.find((session) => session.sessionId === loaded.sessionId),
    );
  });
}
