import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type {
  HostGateway,
  OmpStorePort,
  OmpStoreSessionSummary,
  OmpProcessFactory,
} from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

function fixture(allowDelete: boolean) {
  const cold: OmpStoreSessionSummary = {
    sessionId: "stable",
    sessionPath: "C:/sessions/2026-09-24T00-00-00-000Z_stable.jsonl",
    title: "saved",
    firstUserText: "saved",
    createdAt: 1,
    updatedAt: 2,
  };
  let present = true;
  let deletes = 0;
  const store: OmpStorePort = {
    listSessions: async () => (present ? [cold] : []),
    findSession: async (_, id) => (present && id === cold.sessionId ? cold : null),
    readSessionEntries: async () => [],
    readSubagentEntries: async () => [],
    deleteSession: async () => {
      deletes += 1;
      if (allowDelete) present = false;
      return allowDelete;
    },
  };
  const registry = new SessionRegistry({
    ompFactory: {
      create() {
        throw new Error("core must not start");
      },
    } as OmpProcessFactory,
    store,
    gateway: { emitFrame() {} } as HostGateway,
    directory: createDirectoryStub(),
  });
  return {
    registry,
    get deletes() {
      return deletes;
    },
    get present() {
      return present;
    },
  };
}

test("已加载会话永久删除先删除历史文件，再从列表消失", async () => {
  const state = fixture(true);
  const { registry } = state;
  await registry.resumeSession({
    sessionId: "stable",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await registry.deleteSession("stable");
  assert.equal(state.deletes, 1);
  assert.equal(state.present, false);
  assert.deepEqual(await registry.listLegacySessions("C:/work", "ws"), []);
});

test("已加载会话删除失败不得报告成功，磁盘历史可恢复", async () => {
  const state = fixture(false);
  const { registry } = state;
  const engine = await registry.resumeSession({
    sessionId: "stable",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await assert.rejects(registry.deleteSession("stable"), /cannot delete omp session/);
  assert.equal(state.deletes, 1);
  assert.equal(state.present, true);
  assert.equal(
    await registry.resumeSession({
      sessionId: "stable",
      workspaceId: "ws",
      workspacePath: "C:/work",
    }),
    engine,
  );
});

test("冷会话删除失败保留索引并抛出错误", async () => {
  const state = fixture(false);
  const { registry } = state;
  await registry.createSession({
    sessionId: "unrelated",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await registry.subscribeSessionsIndex({
    workspaceId: "ws",
    workspacePath: "C:/work",
    connectionId: "test",
  });
  await assert.rejects(registry.deleteSession("stable"), /cannot delete omp session/);
  assert.equal(state.deletes, 1);
  assert.equal(state.present, true);
  assert.equal(
    (await registry.listLegacySessions("C:/work", "ws")).some(
      (session) => session.sessionId === "stable",
    ),
    true,
  );
});

test("临时 ID 的运行中会话删除失败后仍可沿原 ID 恢复进程", async () => {
  const sessionPath = "C:/sessions/2026-09-24T00-00-00-000Z_stable.jsonl";
  const resumePaths: (string | undefined)[] = [];
  let deletes = 0;
  const registry = new SessionRegistry({
    ompFactory: {
      create(options) {
        resumePaths.push(options.resumeSessionPath);
        return {
          ompSessionFile: sessionPath,
          async start() {},
          async send() {
            return { success: true };
          },
          respondUi() {},
          async refreshState() {
            return null;
          },
          async readContextReport() {
            return null;
          },
          async dispose() {},
        };
      },
    } as OmpProcessFactory,
    store: {
      listSessions: async () => [],
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => {
        deletes += 1;
        return false;
      },
    } as OmpStorePort,
    gateway: { emitFrame() {} } as HostGateway,
    directory: createDirectoryStub(),
  });
  const engine = await registry.createSession({
    sessionId: "temporary",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await engine.ensureOmpStarted();
  await assert.rejects(registry.deleteSession("temporary"), /cannot delete omp session/);
  assert.equal(registry.getEngine("temporary"), engine);
  await engine.ensureOmpStarted();
  assert.deepEqual(resumePaths, [undefined, sessionPath]);
  assert.equal(deletes, 1);
  await registry.dispose();
});

test("v3 会话目录删除：目录进程 delete_session 成功后按 omp 结果删除（不走本地文件）", async () => {
  const state = fixture(true);
  const { registry } = state;
  await registry.resumeSession({
    sessionId: "stable",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  // 重建带 v3 目录的注册表（fixture 内建旧核桩）：delete_session 成功即视为已删除。
  const directory = createDirectoryStub(() => ({
    success: true,
    data: { sessionId: "stable", deleted: true },
  }));
  directory.setForkSurface(true);
  const store = {
    listSessions: async () => (state.present ? [] : []),
    findSession: async () => null,
    readSessionEntries: async () => [],
    readSubagentEntries: async () => [],
    deleteSession: async () => false,
  } as OmpStorePort;
  const v3registry = new SessionRegistry({
    ompFactory: {
      create() {
        throw new Error("core must not start");
      },
    } as OmpProcessFactory,
    store,
    gateway: { emitFrame() {} } as HostGateway,
    directory,
  });
  await v3registry.createSession({
    sessionId: "local",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await v3registry.deleteSession("stable");
  assert.deepEqual(
    directory.sentDirectoryCommands.filter((command) => command.type === "delete_session"),
    [{ type: "delete_session", sessionId: "stable" }],
  );
  await registry.dispose();
  await v3registry.dispose();
});

test("v3 会话目录删除失败：错误面带 omp 错误码且索引保留", async () => {
  const directory = createDirectoryStub(() => ({
    success: false,
    error: "Close the session's process before deleting it (end the RPC connection, then delete)",
    code: "unsupported",
  }));
  directory.setForkSurface(true);
  const registry = new SessionRegistry({
    ompFactory: {
      create() {
        throw new Error("core must not start");
      },
    } as OmpProcessFactory,
    store: {
      listSessions: async () => [],
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => false,
    } as OmpStorePort,
    gateway: { emitFrame() {} } as HostGateway,
    directory,
  });
  await registry.createSession({ sessionId: "local", workspaceId: "ws", workspacePath: "C:/work" });
  await assert.rejects(
    registry.deleteSession("stable"),
    /Close the session's process before deleting it/,
  );
  await registry.dispose();
});
