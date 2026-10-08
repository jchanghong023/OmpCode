import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import { createLegacyHandlers } from "../src/app/legacyMethods.js";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import { AttachmentStore } from "../src/app/attachmentStore.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";
import { V4CommandService } from "../src/app/v4Commands.js";

test("legacy/v4 压缩：真实核心失败不 accepted，成功仍 accepted", async () => {
  let allowCompaction = false;
  const gateway = { emitFrame() {}, requestUserInput: async () => ({ action: "cancel" as const }) };
  const registry = new SessionRegistry({
    gateway,
    directory: createDirectoryStub(),
    store: {
      listSessions: async () => [],
      findSession: async () => null,
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => false,
    },
    ompFactory: {
      create: () => ({
        ompSessionFile: null,
        async start() {},
        respondUi() {},
        async send(command) {
          return {
            success: command.type !== "compact" || allowCompaction,
            error: "compact refused",
          };
        },
        async refreshState() {
          return null;
        },
        async readContextReport() {
          return null;
        },
        async dispose() {},
      }),
    },
  });
  const attachments = new AttachmentStore();
  try {
    await registry.createSession({ sessionId: "saved", workspaceId: "ws", workspacePath: "." });
    const handlers = createLegacyHandlers({
      registry,
      attachments,
      workspacePath: ".",
      workspaceKey: "ws",
      deliveredAccountConfigRevision: null,
      loadWorkspaceConfig: async () => {
        throw new Error("not used");
      },
    });
    await assert.rejects(
      handlers[zcodeProtocolMethods.sessionCompact]!({ sessionId: "saved" }),
      /omp compaction failed/,
    );
    const v4 = new V4CommandService({
      registry,
      attachments,
      workspaceId: "ws",
      workspacePath: ".",
    });
    const compactCommand = {
      type: "compact",
      commandId: "v4-compact",
      clientId: "client",
      sessionId: "saved",
      payload: {},
      issuedAt: Date.now(),
    };
    await assert.rejects(v4.handle(compactCommand), /omp compaction failed/);
    allowCompaction = true;
    const legacySuccess = await handlers[zcodeProtocolMethods.sessionCompact]!({
      sessionId: "saved",
    });
    assert.ok(legacySuccess && typeof legacySuccess === "object" && "compact" in legacySuccess);
    assert.deepEqual(legacySuccess.compact, { state: "accepted" });
    const v4Success = await v4.handle(compactCommand);
    assert.equal(v4Success.status, "accepted");
  } finally {
    // AttachmentStore 没有 dispose；现有 TTL 清理入口处理记录，未 begin 不会创建 sweeper。
    attachments.sweep(Infinity);
    await registry.dispose();
  }
});
