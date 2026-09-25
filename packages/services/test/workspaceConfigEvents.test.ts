import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWorkspaceConfigEvents } from "../src/zcode-agent/workspaceConfigEvents.js";

test("slash commands are published even when model options are empty", () => {
  const workspace = { workspacePath: "/work", workspaceIdentity: "remote:one" };
  const commands = [{ name: "ship", description: "Ship changes" }];
  const events = projectWorkspaceConfigEvents(workspace, {
    configOptions: [],
    slashCommands: commands,
  });
  assert.deepEqual(events.slashEvent, {
    type: "workspace_slash_commands_update",
    ...workspace,
    commands,
  });
  assert.equal(events.configEvent, null);
});
