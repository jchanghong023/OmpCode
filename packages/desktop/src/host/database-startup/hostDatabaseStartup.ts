import {
  getTasksIndexDatabasePath,
  markTasksStoragePrepared,
  resolveZCodeAgentSpawnCwd,
} from "@zcode/services/storage-startup";
import type { DatabaseStartupState, HostStartupWorkspaceTarget } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../databaseStartupCoordinator.js";
import { StartupDiskSampler } from "../startupDiskSampler.js";
import { prepareHostStorage, prepareSessionStorage } from "./storagePreparationProcesses.js";

const BASELINE_BUDGET_MS = 250;
export function createHostDatabaseStartup(options: {
  startupId?: string;
  cwd: string;
  workspaceTargets?: HostStartupWorkspaceTarget[];
  env?: Record<string, string>;
  publish: (state: DatabaseStartupState) => void;
  initializeServices: () => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const abort = new AbortController();
  let sampler: StartupDiskSampler | undefined;
  const coordinator = new DatabaseStartupCoordinator({
    startupId: options.startupId,
    publish: options.publish,
    prepare: async (report) => {
      const preparedPaths = new Set<string>();
      sampler = new StartupDiskSampler({ onSample: (disk) => coordinator.updateDisk(disk) });
      const currentSampler = sampler;
      const observePath = async (path: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            currentSampler.addPath(path),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BASELINE_BUDGET_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        currentSampler.sealBaseline(path);
        coordinator.updateDisk(currentSampler.snapshot());
      };
      try {
        report("preparing_host_storage", "checking");
        const tasksPath = getTasksIndexDatabasePath();
        await observePath(tasksPath);
        currentSampler.start();
        await prepareHostStorage(
          tasksPath,
          (phase, migration) =>
            report("preparing_host_storage", phase, { databaseId: "tasks-index", migration }),
          abort.signal,
        );
        markTasksStoragePrepared(tasksPath);
        report("preparing_session_storage", "checking");
        const candidates = options.workspaceTargets?.length
          ? options.workspaceTargets
          : [{ workspacePath: options.cwd }];
        const targets = new Map<string, HostStartupWorkspaceTarget>();
        for (const target of candidates) {
          // 同一 cwd 可属于不同身份／profile；只能按原始 workspace 身份去重。
          const key = target.workspaceIdentity?.trim() || target.workspacePath;
          if (!targets.has(key)) targets.set(key, target);
        }
        const pendingTargets = [...targets.values()];
        for (const [index, workspaceTarget] of pendingTargets.entries()) {
          // 历史项目 ENOTDIR/无权限不是数据库失败；fallback 只改变执行 cwd，不改变 profile 归属。
          const { cwd } = await resolveZCodeAgentSpawnCwd({
            requestedCwd: workspaceTarget.workspacePath,
            workspacePath: workspaceTarget.workspacePath,
            spawnFallbackCwd: options.cwd,
          });
          await prepareSessionStorage({
            cwd,
            workspaceTarget,
            env: options.env,
            signal: abort.signal,
            preparedPaths,
            report: (phase, details) =>
              report("preparing_session_storage", phase, {
                databaseId: details?.databaseId ?? "session",
                migration: details?.migration,
                finalDatabase: index === pendingTargets.length - 1,
              }),
            observePath,
          });
        }
        report("starting_services");
        await options.initializeServices();
      } catch (error) {
        try {
          options.onFailure(error);
        } catch {
          /* 诊断失败不覆盖原始错误。 */
        }
        throw error;
      } finally {
        currentSampler.stop();
        coordinator.updateDisk(currentSampler.snapshot());
      }
    },
  });
  return {
    coordinator,
    dispose: () => {
      abort.abort();
      sampler?.stop();
    },
  };
}
