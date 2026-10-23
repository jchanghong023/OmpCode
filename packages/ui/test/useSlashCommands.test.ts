import { describe, expect, it, beforeEach } from "vitest";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

describe("useSlashCommands", () => {
  beforeEach(() => {
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  it("remote workspace 会按 workspaceIdentity 读取 slash commands", () => {
    const workspacePath = "/root";
    const workspaceIdentity = "remote:ssh:demo:22:root:/root";
    useZCodeSessionStore
      .getState()
      .setSlashCommands(
        workspacePath,
        [{ name: "remote-command", description: "remote command" }],
        workspaceIdentity,
      );

    const identityCommands = selectWorkspaceZCodeState(
      useZCodeSessionStore.getState(),
      workspacePath,
      workspaceIdentity,
    ).slashCommands;
    const pathOnlyCommands = selectWorkspaceZCodeState(
      useZCodeSessionStore.getState(),
      workspacePath,
    ).slashCommands;

    expect(identityCommands.map((command) => command.name)).toEqual(["remote-command"]);
    expect(pathOnlyCommands).toEqual([]);
  });

  it("按 workspace 身份保留原生 canonical、alias 和真实目录元数据，不注入静态命令", () => {
    const workspacePath = "/repo";
    const workspaceIdentity = "remote:ssh:other:22:user:/repo";
    const nativeCatalog = [
      {
        name: "goal",
        description: "Manage session goals",
        inputHint: "/goal <action>",
        source: "builtin" as const,
      },
      {
        name: "compact",
        description: "Summarize session context",
        inputHint: "/compact [instructions]",
        source: "builtin" as const,
      },
      {
        name: "compress",
        description: "Alias for /compact",
        inputHint: "/compress [instructions]",
        source: "builtin" as const,
      },
      {
        name: "plan",
        description: "Toggle native planning",
        inputHint: "/plan [on|off]",
        source: "builtin" as const,
      },
      {
        name: "move",
        description: "Move this session",
        inputHint: "/move <directory>",
        source: "builtin" as const,
      },
      {
        name: "wt",
        description: "Manage worktrees",
        inputHint: "/wt <action>",
        source: "builtin" as const,
      },
    ];
    const legacyCatalog = [{ name: "legacy-review", description: "Legacy review command" }];
    useZCodeSessionStore
      .getState()
      .setSlashCommands(workspacePath, nativeCatalog, workspaceIdentity);
    useZCodeSessionStore.getState().setSlashCommands(workspacePath, legacyCatalog);

    expect(
      selectWorkspaceZCodeState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity)
        .slashCommands,
    ).toEqual(nativeCatalog);
    expect(
      selectWorkspaceZCodeState(useZCodeSessionStore.getState(), workspacePath).slashCommands,
    ).toEqual(legacyCatalog);

    useZCodeSessionStore.getState().setSlashCommands(workspacePath, [], workspaceIdentity);
    expect(
      selectWorkspaceZCodeState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity)
        .slashCommands,
    ).toEqual([]);
    expect(
      selectWorkspaceZCodeState(useZCodeSessionStore.getState(), workspacePath).slashCommands,
    ).toEqual(legacyCatalog);
  });
});
