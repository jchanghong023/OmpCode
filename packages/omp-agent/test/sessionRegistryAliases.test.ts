import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpStorePort } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

const canonical = "01a0d66e-1891-7035-ab59-f8e5f0a33703";
const alias = "omp-session-old-gui";
const workspace = { workspaceId: "ws", workspacePath: "C:/alias-work" };
const nativePath = `C:/sessions/2026-10-08T00-00-00-000Z_${canonical}.jsonl`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  options: {
    outputOnly?: boolean;
    readGate?: ReturnType<typeof deferred>;
    disposeGate?: ReturnType<typeof deferred>;
  } = {},
) {
  let present = true;
  let starts = 0;
  let disposals = 0;
  const enteredRead = deferred();
  const enteredDispose = deferred();
  const summary = {
    sessionId: canonical,
    sessionPath: options.outputOnly ? "" : nativePath,
    title: "alias owner",
    firstUserText: null,
    createdAt: 1,
    updatedAt: 2,
    ...(options.outputOnly ? { commandOutputOnly: true as const } : {}),
  };
  const store: OmpStorePort = {
    listSessions: async () => (present ? [summary] : []),
    findSession: async (_cwd, id) => (present && [canonical, alias].includes(id) ? summary : null),
    readSessionEntries: async () => {
      enteredRead.resolve();
      await options.readGate?.promise;
      return [];
    },
    readSubagentEntries: async () => [],
    readCommandOutputs: async () => [{ id: "received", text: "received output", createdAt: 1 }],
    deleteSession: async () => {
      present = false;
      return true;
    },
    deleteCommandOutputs: async () => {
      if (options.outputOnly) present = false;
      return true;
    },
  };
  const directory = createDirectoryStub(() => {
    present = false;
    return { success: true };
  });
  directory.setForkSurface(true);
  const registry = new SessionRegistry({
    store,
    directory,
    gateway: { emitFrame() {} } as HostGateway,
    ompFactory: {
      create: () => ({
        ompSessionFile: nativePath,
        async start() {
          starts += 1;
        },
        async send() {
          return { success: true, data: {} };
        },
        async refreshState() {
          return null;
        },
        async readContextReport() {
          return null;
        },
        respondUi() {},
        async dispose() {
          disposals += 1;
          enteredDispose.resolve();
          await options.disposeGate?.promise;
        },
      }),
    },
  });
  return {
    registry,
    directory,
    store,
    enteredRead,
    enteredDispose,
    starts: () => starts,
    disposals: () => disposals,
  };
}

for (const order of ["canonical-first", "alias-first", "concurrent"] as const) {
  test(`冷别名 ${order} 复用一个投影/进程，alias 删除只释放一个 owner`, async (context) => {
    const f = fixture();
    context.after(() => f.registry.dispose());
    const resume = (id: string) => f.registry.resumeSession({ ...workspace, sessionId: id });
    const [first, second] =
      order === "concurrent"
        ? await Promise.all([resume(canonical), resume(alias)])
        : order === "canonical-first"
          ? [await resume(canonical), await resume(alias)]
          : [await resume(alias), await resume(canonical)];
    assert.equal(first, second);
    assert.equal(f.registry.getEngine(canonical), first);
    assert.equal(f.registry.getEngine(alias), first);
    await Promise.all([first.ensureOmpStarted(), second.ensureOmpStarted()]);
    assert.equal(f.starts(), 1, "两个地址只能建立一个原生 lease");
    await f.registry.deleteSession(alias);
    assert.equal(f.disposals(), 1);
    assert.deepEqual(f.directory.sentDirectoryCommands, [
      { type: "delete_session", sessionId: canonical },
    ]);
    assert.equal(f.registry.getEngine(canonical), null);
    assert.equal(f.registry.getEngine(alias), null);
    for (const id of [canonical, alias]) await assert.rejects(resume(id), /session unavailable/);
  });
}

test("纯派生无原生路径的两个冷地址仍共享唯一 owner", async (context) => {
  const f = fixture({ outputOnly: true });
  context.after(() => f.registry.dispose());
  const first = await f.registry.resumeSession({ ...workspace, sessionId: alias });
  const second = await f.registry.resumeSession({ ...workspace, sessionId: canonical });
  assert.equal(first, second);
  assert.equal(first.ompSessionFile, null);
  assert.equal(f.starts(), 0);
  await f.registry.deleteSession(canonical);
  assert.equal(f.directory.sentDirectoryCommands.length, 0);
  assert.equal(f.registry.getEngine(alias), null);
});

test("alias 删除屏障阻止在途 canonical 水合登记复活", async (context) => {
  const readGate = deferred();
  const f = fixture({ readGate });
  context.after(() => f.registry.dispose());
  const resuming = f.registry.resumeSession({ ...workspace, sessionId: canonical });
  await f.enteredRead.promise;
  await f.registry.deleteSession(alias);
  readGate.resolve();
  await assert.rejects(resuming, /session unavailable/);
  assert.equal(f.registry.getEngine(canonical), null);
  assert.equal(f.registry.getEngine(alias), null);
  assert.equal(f.starts(), 0);
});

test("alias 关闭窗口拒绝复用 owner/canonical，结束后两地址可重新恢复", async (context) => {
  const disposeGate = deferred();
  const f = fixture({ disposeGate });
  context.after(() => f.registry.dispose());
  const first = await f.registry.resumeSession({ ...workspace, sessionId: canonical });
  assert.equal(await f.registry.resumeSession({ ...workspace, sessionId: alias }), first);
  await first.ensureOmpStarted();
  const closing = f.registry.closeSession(alias);
  await f.enteredDispose.promise;
  for (const id of [canonical, alias])
    await assert.rejects(
      f.registry.resumeSession({ ...workspace, sessionId: id }),
      /session unavailable/,
    );
  disposeGate.resolve();
  await closing;
  assert.equal(f.registry.getEngine(canonical), null);
  assert.equal(f.registry.getEngine(alias), null);
  const reopened = await f.registry.resumeSession({ ...workspace, sessionId: alias });
  assert.notEqual(reopened, first);
  assert.equal(await f.registry.resumeSession({ ...workspace, sessionId: canonical }), reopened);
});

test("权威 cold alias 不跨 workspace identity 或原生 file epoch 复用 owner", async (context) => {
  const f = fixture();
  context.after(() => f.registry.dispose());
  const first = await f.registry.resumeSession({ ...workspace, sessionId: canonical });
  const alternatePath = `C:/different-sessions/2026-10-08T00-00-00-000Z_${canonical}.jsonl`;
  f.store.findSession = async () => ({
    sessionId: canonical,
    sessionPath: alternatePath,
    title: null,
    firstUserText: null,
    createdAt: 1,
    updatedAt: 2,
  });
  const other = await f.registry.resumeSession({
    workspaceId: "other",
    workspacePath: "C:/other-work",
    sessionId: alias,
  });
  assert.notEqual(other, first);
  assert.equal(other.ompSessionFile, alternatePath);
  assert.equal(f.registry.getEngine(canonical), first);
  assert.equal(f.registry.getEngine(alias), other);
  assert.equal(f.starts(), 0);
});
