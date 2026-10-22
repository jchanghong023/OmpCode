export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultZCodeAgentCommand } from "#src/zcode-agent/zcodeAgentProcessManager.js";
export { buildZCodeAgentCommandEnv } from "#src/zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentStoragePreparation,
} from "#src/zcode-agent/zcodeAgentProcessManager.js";
export {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
  captureProcessTreeSnapshotAsync,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessGroupSnapshot,
} from "#src/process/processTreeTerminator.js";
export type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
export { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";

export { createSettingService } from "#src/setting/settingService.js";
