import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareRealOmpFixture,
  realOmpSkip,
} from "../../omp-agent/test/fixtures/realOmpHarness.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// Only command resolution is gated: every successful launch runs the current
// cliMain adapter and installed OMP with the shared fixture's isolated config.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "same-generation concurrent consumers share real adapter startup and retain separate sessions",
  {
    skip: realOmpSkip,
  },
  async () => {
    const fixture = await prepareRealOmpFixture();
    setDataBaseDir(fixture.root);
    const target = { workspacePath: fixture.workspace };
    const entered = deferred();
    const release = deferred();
    let starts = 0;
    const service = createZCodeAgentService({
      requestTimeoutMs: 120_000,
      commandResolver: async () => {
        starts += 1;
        entered.resolve();
        await release.promise;
        return fixture.launch;
      },
    });
    try {
      const results = Promise.all([
        service.getOmpModelRoles(target),
        service.getOmpModelRoles(target),
      ]);
      await entered.promise;
      release.resolve();
      const catalogs = await results;
      for (const catalog of catalogs)
        assert.ok(catalog.roles.length > 0, "installed OMP must answer the directory command");
      const [first, second] = await Promise.all([
        service.createSession(target),
        service.createSession(target),
      ]);
      const firstId = first.session.sessionId;
      const secondId = second.session.sessionId;
      assert.ok(firstId);
      assert.ok(secondId);
      assert.notEqual(firstId, secondId);
      assert.equal(starts, 1);
      const runtime = await service.getWorkspaceRuntimeIdentity(target);
      assert.ok(runtime.processId && runtime.processId > 0);
      assert.equal(runtime.generation, 1);
      assert.deepEqual(await service.readSessionMessages({ ...target, sessionId: firstId }), []);
      assert.deepEqual(await service.readSessionMessages({ ...target, sessionId: secondId }), []);

      assert.equal(await service.closeSession({ ...target, sessionId: firstId }), true);
      await assert.rejects(service.readSessionMessages({ ...target, sessionId: firstId }));
      // Closing one real engine must not remove another consumer's session or
      // recycle the shared adapter. The remaining session stays publicly readable.
      assert.deepEqual(await service.readSessionMessages({ ...target, sessionId: secondId }), []);
      assert.deepEqual(await service.getWorkspaceRuntimeIdentity(target), runtime);
      assert.equal(await service.closeSession({ ...target, sessionId: secondId }), true);
      assert.equal(starts, 1);
      assert.equal(fixture.mock.calls.length, 0, "empty-session lifecycle must not call a model");
      fixture.mock.assertHealthy();
    } finally {
      release.resolve();
      try {
        await service.disposeAllAndWait();
      } finally {
        setDataBaseDir(null);
        await fixture.close();
      }
    }
  },
);

test(
  "release cancels old startup without dispatch, and the next real adapter generation remains usable",
  {
    skip: realOmpSkip,
  },
  async () => {
    const fixture = await prepareRealOmpFixture();
    setDataBaseDir(fixture.root);
    const target = { workspacePath: fixture.workspace };
    const entered = deferred();
    const release = deferred();
    let starts = 0;
    const service = createZCodeAgentService({
      requestTimeoutMs: 120_000,
      commandResolver: async () => {
        starts += 1;
        if (starts === 1) {
          entered.resolve();
          await release.promise;
        }
        return fixture.launch;
      },
    });
    try {
      const old = service.getOmpModelRoles(target);
      const rejected = assert.rejects(old, /cancelled|unavailable/i);
      await entered.promise;
      await service.disposeWorkspace(target);
      release.resolve();
      await rejected;
      // Observation cannot revive the cancelled generation before a new consumer.
      await assert.rejects(service.getWorkspaceRuntimeIdentity(target));
      const catalog = await service.getOmpModelRoles(target);
      assert.ok(catalog.roles.length > 0, "the replacement adapter must reach installed OMP");
      const created = await service.createSession(target);
      const sessionId = created.session.sessionId;
      assert.ok(sessionId);
      assert.equal(starts, 2);
      assert.deepEqual(await service.readSessionMessages({ ...target, sessionId }), []);
      const runtime = await service.getWorkspaceRuntimeIdentity(target);
      assert.ok(runtime.processId && runtime.processId > 0);
      assert.equal(runtime.generation, 1, "cancelled resolution must not spawn a hidden adapter");
      assert.equal(await service.closeSession({ ...target, sessionId }), true);
      assert.equal(fixture.mock.calls.length, 0);
      fixture.mock.assertHealthy();
    } finally {
      release.resolve();
      try {
        await service.disposeAllAndWait();
      } finally {
        setDataBaseDir(null);
        await fixture.close();
      }
    }
  },
);

test(
  "failed startup is shared by concurrent consumers and does not poison the next real attempt",
  {
    skip: realOmpSkip,
  },
  async () => {
    const fixture = await prepareRealOmpFixture();
    setDataBaseDir(fixture.root);
    const target = { workspacePath: fixture.workspace };
    const entered = deferred();
    const release = deferred();
    let starts = 0;
    const service = createZCodeAgentService({
      requestTimeoutMs: 120_000,
      commandResolver: async () => {
        starts += 1;
        if (starts === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("isolated startup failure");
        }
        return fixture.launch;
      },
    });
    try {
      const results = Promise.allSettled([
        service.getOmpModelRoles(target),
        service.getOmpModelRoles(target),
      ]);
      await entered.promise;
      release.resolve();
      for (const result of await results) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected")
          assert.match(String(result.reason), /isolated startup failure/);
      }
      assert.equal(starts, 1);
      await assert.rejects(service.getWorkspaceRuntimeIdentity(target));
      const catalog = await service.getOmpModelRoles(target);
      assert.ok(
        catalog.roles.length > 0,
        "retry must reach installed OMP through the real adapter",
      );
      const created = await service.createSession(target);
      const sessionId = created.session.sessionId;
      assert.ok(sessionId);
      assert.equal(starts, 2);
      assert.deepEqual(await service.readSessionMessages({ ...target, sessionId }), []);
      const runtime = await service.getWorkspaceRuntimeIdentity(target);
      assert.ok(runtime.processId && runtime.processId > 0);
      assert.equal(runtime.generation, 1);
      assert.equal(await service.closeSession({ ...target, sessionId }), true);
      assert.equal(fixture.mock.calls.length, 0);
      fixture.mock.assertHealthy();
    } finally {
      release.resolve();
      try {
        await service.disposeAllAndWait();
      } finally {
        setDataBaseDir(null);
        await fixture.close();
      }
    }
  },
);
