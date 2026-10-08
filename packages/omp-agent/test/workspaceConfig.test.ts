import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceConfigLoader } from "../src/adapters/workspaceConfig.js";
import type { OmpDirectoryGatewayPort } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

function loaderWith(send: OmpDirectoryGatewayPort["send"]) {
  const directory: OmpDirectoryGatewayPort = { ...createDirectoryStub(), send };
  return createWorkspaceConfigLoader(".", { directory });
}

test("聚合目录的命令失败仅降级命令，保留真实模型候选和当前选择", async () => {
  for (const transportFailure of [false, true]) {
    const loader = loaderWith(async (command) => {
      switch (command.type) {
        case "get_available_commands":
          if (transportFailure) throw new Error("command transport failed");
          return { success: false, error: "command catalog failed" };
        case "get_available_models":
          return {
            success: true,
            data: { models: [{ provider: "smoke", id: "one", name: "Smoke One" }] },
          };
        case "get_available_thinking_levels":
          return { success: true, data: { levels: ["off", "high"] } };
        case "get_state":
          return {
            success: true,
            data: { model: { provider: "smoke", id: "one" }, thinkingLevel: "high" },
          };
        default:
          throw new Error("unexpected directory command");
      }
    });
    const config = await loader.loadWorkspaceConfig();
    assert.equal(config.slashCommands.length, 0);
    const model = config.configOptions.find((option) => option.id === "model");
    assert.ok(model && "options" in model && Array.isArray(model.options));
    assert.equal(model.currentValue, "smoke/one");
    assert.deepEqual(
      model.options.map((option) => option.value),
      ["smoke/one"],
    );
    const thought = config.configOptions.find((option) => option.id === "thought_level");
    assert.ok(thought && "options" in thought && Array.isArray(thought.options));
    assert.equal(thought.currentValue, "high");
    assert.deepEqual(
      thought.options.map((option) => option.value),
      ["off", "high"],
    );
  }
});

test("无账号的合法空模型目录不阻塞空命令或正常扩展命令展示", async () => {
  for (const commands of [
    [],
    [{ name: "hello-ext", source: "extension", description: "Local editor" }],
  ]) {
    const loader = loaderWith(async (command) => ({
      success: true,
      data:
        command.type === "get_available_commands"
          ? { commands }
          : command.type === "get_available_models"
            ? { models: [] }
            : command.type === "get_available_thinking_levels"
              ? { levels: [] }
              : {},
    }));
    const config = await loader.loadWorkspaceConfig();
    assert.deepEqual(
      config.slashCommands.map((command) => command.name),
      commands.map((command) => command.name),
    );
    const model = config.configOptions.find((option) => option.id === "model");
    assert.ok(model && "options" in model && Array.isArray(model.options));
    assert.equal(model.options.length, 0);
  }
});
