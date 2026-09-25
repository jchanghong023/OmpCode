import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";

export function projectWorkspaceConfigEvents(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  config: WorkspaceConfigState,
): {
  slashEvent: Extract<ZCodeWorkspaceEvent, { type: "workspace_slash_commands_update" }>;
  configEvent: Extract<ZCodeWorkspaceEvent, { type: "workspace_config_options_update" }> | null;
} {
  return {
    slashEvent: {
      type: "workspace_slash_commands_update",
      ...workspace,
      commands: config.slashCommands,
    },
    configEvent:
      config.configOptions.length > 0
        ? {
            type: "workspace_config_options_update",
            ...workspace,
            configOptions: config.configOptions,
          }
        : null,
  };
}
