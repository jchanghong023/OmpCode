import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRunTransportMethods } from "../src/v4/agentConversationTransportWorkflowRuns.js";

test("OMP workflowRuns 本地明确拒绝，不握手、不调用 Host、不伪造空结果", async () => {
  const methods = createWorkflowRunTransportMethods({
    agentService: new Proxy({} as never, {
      get() {
        assert.fail("unsupported workflow query must not call the Host");
      },
    }),
    ensureHandshake: async () => assert.fail("unsupported query must not start a handshake"),
    workspace: { workspacePath: "/test-workspace" },
  });
  await assert.rejects(
    methods.workflowRuns({ sessionId: "session", limit: 64 }),
    /capabilityUnsupported: v4\/conversation\/workflowRuns/,
  );
});
