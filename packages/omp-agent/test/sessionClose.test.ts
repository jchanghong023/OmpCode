import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "../src/app/ports.js";

test("closing a session removes its disposed engine", async () => {
  let disposals = 0;
  const registry = new SessionRegistry({
    ompFactory: {
      create: () => ({
        ompSessionFile: null,
        async start() {},
        async send() {
          return { success: true };
        },
        respondUi() {},
        async refreshState() {
          return null;
        },
        async dispose() {
          disposals += 1;
        },
      }),
    } as OmpProcessFactory,
    store: {
      listSessions: async () => [],
      readSessionEntries: async () => [],
      deleteSession: async () => true,
    } as OmpStorePort,
    gateway: { emitFrame() {} } as HostGateway,
  });
  await registry.createSession({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
  });
  const engine = registry.requireEngine("session");
  await engine.ensureOmpStarted();
  await registry.closeSession("session");
  assert.equal(disposals, 1);
  assert.equal(registry.getEngine("session"), null);
});
