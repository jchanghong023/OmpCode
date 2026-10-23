import { describe, expect, it } from "vitest";
import { resolveExternalAgentWiring } from "../src/runtime/agentWiring.js";

describe("resolveExternalAgentWiring", () => {
  it.each(["", "   "])("rejects explicit empty command %j without fallback", (command) => {
    expect(() => resolveExternalAgentWiring({ ZCODE_AGENT_SERVER_COMMAND: command })).toThrow(
      /ZCODE_AGENT_SERVER_COMMAND must not be empty/,
    );
  });
});
