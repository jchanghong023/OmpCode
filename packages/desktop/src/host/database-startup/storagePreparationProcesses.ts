import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import {
  applyOmpProfileToCommand,
  createSettingService,
  getTasksIndexDatabasePath,
} from "@zcode/services/node";
import {
  type DatabaseMigrationFacts,
  zcodeStoragePreparationFrameSchema,
  ompStartupProfileNotificationSchema,
  type OmpStartupProfileParams,
  type DatabaseStartupState,
  type HostStartupWorkspaceTarget,
} from "@zcode/shared";
import {
  resolveDefaultZCodeAgentCommand,
  buildZCodeAgentCommandEnv,
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
  captureProcessTreeSnapshotAsync,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessGroupSnapshot,
  type ProcessTreeSnapshot,
} from "@zcode/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
import { workerMessageSchema } from "./contract.js";
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve();
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

/** Prepare the selected runtime through its explicit Worker or executable boundary. */
export async function prepareSessionStorage(options: {
  cwd: string;
  workspaceTarget?: HostStartupWorkspaceTarget;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const target = options.workspaceTarget ?? { workspacePath: options.cwd };
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const settings = await createSettingService().get();
  const inheritedRoot = settings.ompProfileLaunchRoots?.[workspaceKey];
  const spawnEnv = {
    ...options.env,
    ...(inheritedRoot ? { OMP_CONFIG_ROOT: inheritedRoot } : {}),
  };
  const resolvedCommand = resolveDefaultZCodeAgentCommand({
    ...target,
    workspaceKey,
    presentationSurface: "desktop",
    env: { ...process.env, ...spawnEnv },
  });
  // cwd 可能已回退到宿主目录，保存的 profile 仍必须按原始目标与正常启动同键读取。
  const profile = settings.ompProfileSelections?.[workspaceKey];
  const command = resolvedCommand
    ? applyOmpProfileToCommand(resolvedCommand, profile)
    : resolvedCommand;
  if (
    inheritedRoot &&
    command?.env?.OMP_CONFIG_ROOT &&
    resolvePath(command.env.OMP_CONFIG_ROOT) !== resolvePath(inheritedRoot)
  )
    throw Object.assign(
      new Error("Explicit launch root conflicts with inherited workspace profile root"),
      { code: "omp.profileRootPinned" },
    );
  if (!command?.supportsStorageStartup || !command.storagePreparation)
    throw statusError("unsupported_runtime");
  options.signal.throwIfAborted();
  const preparation = command.storagePreparation;
  // 与正常启动一致：清洗继承环境后合入可信补丁，命令环境优先。
  const env = buildZCodeAgentCommandEnv(
    process.env,
    { ...spawnEnv, ...command.env },
    target.workspaceIdentity,
  );
  const cwd = command.cwd ?? options.cwd;
  const completion = Promise.withResolvers<void>();
  const spawnedAt = Date.now();
  let exitedAt: number | undefined;
  const { resolve, reject } = completion;
  {
    const args = [...(command.args ?? [])];
    if (!args.includes("--cwd") && !args.some((arg) => arg.startsWith("--cwd=")))
      args.push("--cwd", cwd);
    args.push("--prepare-storage");
    const external =
      preparation.kind === "command"
        ? spawn(command.command, args, {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: shouldSpawnInDetachedProcessGroup(),
          })
        : undefined;
    const child =
      external ??
      new Worker(preparation.kind === "node-worker" ? preparation.entry : "", {
        argv: [
          ...(command.args?.slice(1).length
            ? command.args.slice(1)
            : ["app-server", "--stdio", "--surface", "desktop"]),
          "--prepare-storage",
          "--cwd",
          cwd,
        ],
        env,
        stdin: true,
        stdout: true,
        stderr: true,
      });
    const input = child.stdin!;
    const output = child.stdout!;
    output.setEncoding("utf8");
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let preparedIndexPath: string | undefined;
    let profileFacts: OmpStartupProfileParams | undefined;
    let pathConfirmed = false;
    let reused = false;
    let state:
      | { attemptId: string; databaseId: string; sequence: number; phase: string }
      | undefined;
    let buffer = "";
    let failure: unknown;
    let cleanup: Promise<{ remainingPids: number[] }> | undefined;
    let outputEnded = false;
    let externalExitCode: number | null | undefined;
    const cleanupExternal = () =>
      (cleanup ??= (async () => {
        const root = external!;
        const childHadExited = root.exitCode !== null || root.signalCode !== null;
        const ownership = {
          ownedProcessStartedAtMs: spawnedAt,
          resolveOwnedProcessExitedAtMs: () => exitedAt,
        };
        let snapshot: ProcessTreeSnapshot | undefined = childHadExited
          ? undefined
          : await captureProcessTreeSnapshotAsync(root, ownership);
        if (!snapshot) {
          if (process.platform === "win32" && !childHadExited && root.pid) {
            // 身份查询失败不代表原子进程已经退出，必须保留不可验证的归属。
            snapshot = {
              rootPid: root.pid,
              descendantPids: [],
              identities: [],
              identityVerification: "unavailable",
            };
          } else if (root.pid && shouldSpawnInDetachedProcessGroup()) {
            snapshot = captureProcessGroupSnapshot(root.pid);
          } else {
            snapshot = await captureExitedRootDescendantsSnapshotAsync(root.pid ?? 0, {
              ...ownership,
              ownedProcessExitedAtMs: exitedAt ?? Date.now(),
            });
            if (!snapshot && process.platform === "win32" && root.pid) {
              snapshot = {
                rootPid: root.pid,
                descendantPids: [],
                identities: [],
                identityVerification: "unavailable",
              };
            }
          }
        }
        // 与正常 stdio transport 一样，先保全归属再请求 EOF；等待 ACK 的进程也能收尾。
        if (!input.destroyed && input.writable) {
          try {
            input.end();
          } catch {
            // 进程可能已经关闭输入，不能因此跳过后续自有进程树回收。
          }
        }
        return await terminateProcessTreeAndWait(root, {
          ...(root.pid && shouldSpawnInDetachedProcessGroup()
            ? { ownedProcessGroupId: root.pid }
            : {}),
          ...ownership,
          ...(snapshot ? { snapshot } : {}),
        });
      })());
    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstStateTimer);
      if (external) {
        try {
          const result = await cleanupExternal();
          if (result.remainingPids.length > 0) failure ??= statusError("transport_closed");
        } catch (error) {
          failure ??= error;
        }
      }
      // 清理屏障完成前取消仍然有效，不能把正常退出转成业务启动成功。
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted)
        failure ??= options.signal.reason ?? statusError("transport_closed");
      if (code === 0 && prepared && !failure && buffer.length === 0) {
        if (preparedPath) options.preparedPaths?.add(preparedPath);
        if (preparedIndexPath) options.preparedPaths?.add(preparedIndexPath);
        resolve();
      } else reject(failure ?? statusError("transport_closed"));
    };
    const terminate = () => {
      if (external) {
        void cleanupExternal().then(
          () => finish(null),
          (error) => {
            failure ??= error;
            void finish(null);
          },
        );
      } else void (child as Worker).terminate();
    };
    const abort = () => {
      failure ??= options.signal.reason ?? statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure ??= statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧，stderr 排空但不把可能含本地路径的原始文本上报。
    child.stderr!.resume();
    input.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    const acceptLine = (line: string) => {
      try {
        if (prepared || failure || Buffer.byteLength(line, "utf8") > 65536)
          throw statusError("transport_closed");
        const raw: unknown = JSON.parse(line);
        const profile = ompStartupProfileNotificationSchema.safeParse(raw);
        if (profile.success) {
          if (profileFacts || pathReceived || !isAbsolute(profile.data.params.configRoot))
            throw statusError("transport_closed");
          profileFacts = profile.data.params;
          return;
        }
        const frame = zcodeStoragePreparationFrameSchema.parse(raw);
        if (frame.method === "startup/storagePath") clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
          if (!profileFacts) throw statusError("unsupported_runtime");
          const indexPath = getTasksIndexDatabasePath({
            configRoot: profileFacts.configRoot,
            profileId: profileFacts.activeProfile,
          });
          if (pathReceived || !isAbsolute(frame.params.path)) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 原生进程确认的实际 root/profile 同时决定 Host 索引库，不能拿 pending 偏好选库。
            if (!options.preparedPaths?.has(indexPath)) {
              await options.observePath(indexPath);
              await prepareHostStorage(
                indexPath,
                (phase, migration) =>
                  options.report(phase, { databaseId: "tasks-index", migration }),
                options.signal,
              );
              // 原因：取消/进程清理未完成时不能发布本 attempt 的成功 memo；实际库无需回滚。
              preparedIndexPath = indexPath;
            }
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            reused = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reused) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted) {
              pathConfirmed = true;
              input.write(
                `${JSON.stringify({ method: "startup/storagePathReady", reuse: reused })}\n`,
              );
            }
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          if (!pathConfirmed || (!reused && state?.phase !== "ready"))
            throw statusError("transport_closed");
          prepared = true;
          input.end();
        } else {
          const next = frame.params;
          if (
            !pathConfirmed ||
            reused ||
            next.databaseKind !== "session" ||
            (state &&
              (next.attemptId !== state.attemptId ||
                next.databaseId !== state.databaseId ||
                next.sequence <= state.sequence ||
                state.phase === "ready" ||
                state.phase === "failed"))
          )
            throw statusError("transport_closed");
          state = next;
          if (next.phase === "failed") {
            failure ??= statusError(next.errorCode ?? "sql_failed", next, next.databaseId);
            terminate();
          } else
            options.report(next.phase, { databaseId: next.databaseId, migration: next.migration });
        }
      } catch (error) {
        failure ??= error;
        terminate();
      }
    };
    output.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1 && !failure) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        acceptLine(line);
      }
      if (Buffer.byteLength(buffer, "utf8") > 65536) {
        failure ??= statusError("transport_closed");
        terminate();
      }
    });
    output.once("end", () => {
      outputEnded = true;
      if (!prepared || buffer.length > 0) {
        failure ??= statusError("transport_closed");
        terminate();
      }
      if (externalExitCode !== undefined) void finish(externalExitCode);
    });
    external?.once("exit", (code) => {
      exitedAt = Date.now();
      externalExitCode = code;
      // close waits for inherited stdio too; begin owned-tree cleanup at root exit,
      // rather than waiting for descendants to release the pipes before killing them.
      void cleanupExternal().then(
        (result) => {
          if (result.remainingPids.length > 0) failure ??= statusError("transport_closed");
          if (code !== 0 || outputEnded || failure) void finish(code);
        },
        (error) => {
          failure ??= error;
          void finish(code);
        },
      );
    });
    child.once("error", (error) => {
      failure ??= error;
      terminate();
    });
    if (external)
      external.once("close", (code) => {
        void finish(code);
      });
    else
      child.once("exit", (code) => {
        void finish(code);
      });
    if (options.signal.aborted) abort();
  }
  await completion.promise;
}
