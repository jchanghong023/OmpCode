import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import type * as WorkerThreads from "node:worker_threads";
import type * as Events from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type * as StorageStartup from "@zcode/services/storage-startup";
import type * as NodeServices from "@zcode/services/node";
import type * as ProcessTreeSnapshotAsync from "../../services/src/process/processTreeSnapshotAsync.js";
import type { ProcessTreeTerminatorWaitOptions } from "../../services/src/process/processTreeTypes.js";
const resolver = vi.hoisted(() => vi.fn());
const profileSettings = vi.hoisted(() => ({
  selections: {} as Record<string, string | null>,
  roots: {} as Record<string, string>,
}));
const indexPreparation = vi.hoisted(() => ({
  paths: [] as string[],
  run: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof WorkerThreads>();
  const { EventEmitter } = await vi.importActual<typeof Events>("node:events");
  return {
    ...original,
    Worker: function (
      filename: ConstructorParameters<typeof original.Worker>[0],
      options?: ConstructorParameters<typeof original.Worker>[1],
    ) {
      if (!String(filename).endsWith("/tasksStorageWorker.js")) {
        return new original.Worker(filename, options);
      }
      const worker = new EventEmitter();
      const path = options?.workerData.path as string;
      indexPreparation.paths.push(path);
      let exited = false;
      queueMicrotask(() => {
        void (async () => {
          try {
            await indexPreparation.run?.(path);
            if (exited) return;
            exited = true;
            worker.emit("message", { type: "done" });
            worker.emit("exit", 0);
          } catch (error) {
            if (exited) return;
            exited = true;
            worker.emit("error", error);
            worker.emit("exit", 1);
          }
        })();
      });
      return Object.assign(worker, {
        terminate: async () => {
          if (!exited) {
            exited = true;
            worker.emit("exit", 1);
          }
          return 1;
        },
      });
    },
  };
});
vi.mock("@zcode/services/node", async (importOriginal) => {
  const original = await importOriginal<typeof NodeServices>();
  return {
    ...original,
    createSettingService: () => ({
      get: async () => ({
        ompProfileSelections: profileSettings.selections,
        ompProfileLaunchRoots: profileSettings.roots,
      }),
    }),
  };
});
const cleanupControl = vi.hoisted(() => ({
  unavailable: false,
  spawned: undefined as undefined | ((child: ChildProcess) => void),
  run: undefined as
    | undefined
    | ((
        child: ChildProcess,
        options: ProcessTreeTerminatorWaitOptions,
      ) => Promise<{ remainingPids: number[] }>),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args);
      cleanupControl.spawned?.(child);
      return child;
    },
  };
});
vi.mock("../../services/src/process/processTreeSnapshotAsync.js", async (importOriginal) => {
  const original = await importOriginal<typeof ProcessTreeSnapshotAsync>();
  return {
    ...original,
    captureProcessTreeSnapshotAsync: (
      ...args: Parameters<typeof original.captureProcessTreeSnapshotAsync>
    ) =>
      cleanupControl.unavailable
        ? Promise.resolve(undefined)
        : original.captureProcessTreeSnapshotAsync(...args),
    captureExitedRootDescendantsSnapshotAsync: (
      ...args: Parameters<typeof original.captureExitedRootDescendantsSnapshotAsync>
    ) =>
      cleanupControl.unavailable
        ? Promise.resolve(undefined)
        : original.captureExitedRootDescendantsSnapshotAsync(...args),
  };
});
vi.mock("@zcode/services/storage-startup", async (importOriginal) => {
  const original = await importOriginal<typeof StorageStartup>();
  return {
    ...original,
    resolveDefaultZCodeAgentCommand: resolver,
    terminateProcessTreeAndWait: (
      ...args: Parameters<typeof original.terminateProcessTreeAndWait>
    ) =>
      cleanupControl.run
        ? cleanupControl.run(...args)
        : original.terminateProcessTreeAndWait(...args),
  };
});
import { prepareSessionStorage } from "../src/host/database-startup/storagePreparationProcesses.js";
import { applyOmpProfileToCommand, getTasksIndexDatabasePath } from "@zcode/services/node";

function startupProfileLine(configRoot: string, activeProfile: string | null = null): string {
  return (
    JSON.stringify({
      method: "omp/startup/profile",
      params: { configRoot, activeProfile, storageScope: `scope:${activeProfile ?? "default"}` },
    }) + "\n"
  );
}

it("uses a Host-owned Worker and waits for the preparation completion frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-worker-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const { isMainThread } = require('node:worker_threads');
    if (isMainThread) process.exit(5);
    const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:1,databaseId:'db',databaseKind:'session',phase:'checking',elapsedMs:0}})+'\\n');
      process.stdout.write(JSON.stringify({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:2,databaseId:'db',databaseKind:'session',phase:'ready',elapsedMs:0}})+'\\n');
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    process.stdout.write(${JSON.stringify(startupProfileLine(dir))});
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:cwd+'/relative.sqlite'}})+'\\n');
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparation: { kind: "node-worker", entry },
  });
  const paths: string[] = [];
  try {
    await prepareSessionStorage({
      cwd: dir,
      signal: new AbortController().signal,
      report: () => {},
      observePath: async (path) => {
        paths.push(path);
      },
    });
    expect(paths).toEqual([
      getTasksIndexDatabasePath({ configRoot: dir, profileId: null }),
      dir + "/relative.sqlite",
    ]);
    await writeFile(entry, "process.exit(0)");
    await expect(
      prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
      }),
    ).rejects.toThrow("transport_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("SILENTDB-06: reuses only successful paths in this attempt and keeps different databases separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-dedup-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const path = process.env.TEST_DB_PATH;
    const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
    lines.once('line', line => {
      const reuse = JSON.parse(line).reuse;
      if (!reuse) {
        send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'attempt',sequence:1,databaseId:'db',databaseKind:'session',phase:'checking',elapsedMs:0}});
        send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'attempt',sequence:2,databaseId:'db',databaseKind:'session',phase:'ready',elapsedMs:0}});
      }
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(process.env.TEST_FAIL === 'yes' ? 1 : 0));
    });
    process.stdout.write(${JSON.stringify(startupProfileLine(dir))});
    send({method:'startup/storagePath',params:{path}});
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparation: { kind: "node-worker", entry },
  });
  const preparedPaths = new Set<string>();
  const report = vi.fn();
  const observePath = vi.fn(async () => {});
  const prepare = (name: string, fail = false) =>
    prepareSessionStorage({
      cwd: dir,
      env: { TEST_DB_PATH: join(dir, name), TEST_FAIL: fail ? "yes" : "no" },
      signal: new AbortController().signal,
      report,
      observePath,
      preparedPaths,
    });
  try {
    await prepare("shared.sqlite");
    await prepare("shared.sqlite");
    expect(observePath).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
    const indexPath = getTasksIndexDatabasePath({ configRoot: dir, profileId: null });
    expect(indexPreparation.paths.filter((path) => path === indexPath)).toEqual([indexPath]);
    await prepare("other.sqlite");
    expect(observePath).toHaveBeenCalledTimes(3);
    await expect(prepare("failed.sqlite", true)).rejects.toThrow("transport_closed");
    expect(preparedPaths.has(join(dir, "failed.sqlite"))).toBe(false);
    await prepare("failed.sqlite");
    expect(observePath).toHaveBeenCalledTimes(5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["success", "malformed", "nonzero", "eof", "sequence", "failed", "cancel"])(
  "external preparation uses the resolved executable and fails closed: %s",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-command-"));
    const entry = join(dir, "external.cjs");
    const controller = new AbortController();
    const preparedPaths = new Set<string>();
    const report = vi.fn();
    await writeFile(
      entry,
      `
      const {isMainThread}=require('node:worker_threads');
      if(!isMainThread || !process.argv.includes('--prepare-storage') || process.env.PREPARE_TOKEN!=='same') process.exit(9);
      const send=f=>process.stdout.write(JSON.stringify(f)+'\\n');
      const mode=${JSON.stringify(mode)};
      if(mode==='eof') process.exit(0);
      if(mode==='malformed') {console.log('not-json'); process.stdin.resume();}
      else {
        const state=(phase,sequence)=>send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence,databaseId:'db',databaseKind:'session',phase,elapsedMs:0,...(phase==='failed'?{errorCode:'sql_failed'}:{})}});
        require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
          if(JSON.parse(line).reuse!==false) process.exit(8);
          if(mode==='cancel') return;
          state('checking',1);
          if(mode==='failed') {state('failed',2);return;}
          state('ready',mode==='sequence'?1:2);
          process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n',()=>process.exit(mode==='nonzero'?3:0));
        });
        process.stdout.write(${JSON.stringify(startupProfileLine(dir, "isolated"))});
        send({method:'startup/storagePath',params:{path:${JSON.stringify(join(dir, "session.sqlite"))}}});
      }
    `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [entry, "app-server", "--stdio", "--surface", "desktop", "--profile", "isolated"],
      cwd: dir,
      env: { PREPARE_TOKEN: "same" },
      supportsStorageStartup: true,
      storagePreparation: { kind: "command" },
    });
    try {
      const result = prepareSessionStorage({
        cwd: dir,
        env: { ZCODE_AGENT_SERVER_COMMAND: process.execPath },
        signal: controller.signal,
        report,
        observePath: async () => {
          if (mode === "cancel") controller.abort(new Error("cancelled"));
        },
        preparedPaths,
      });
      if (mode === "success") await result;
      else await expect(result).rejects.toThrow(mode === "cancel" ? "cancelled" : undefined);
      expect(preparedPaths.has(join(dir, "session.sqlite"))).toBe(mode === "success");
      if (mode === "nonzero") {
        // A complete ready/prepared handshake must still reject a nonzero root exit.
        expect(report).toHaveBeenLastCalledWith("ready", {
          databaseId: "db",
          migration: undefined,
        });
      }
      expect(resolver).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ ZCODE_AGENT_SERVER_COMMAND: process.execPath }),
        }),
      );
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("keeps the existing first-frame deadline for an external runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-timeout-"));
  const entry = join(dir, "silent.cjs");
  await writeFile(entry, "process.stdin.resume();");
  resolver.mockReturnValue({
    command: process.execPath,
    args: [entry, "app-server", "--stdio"],
    cwd: dir,
    supportsStorageStartup: true,
    storagePreparation: { kind: "command" },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = prepareSessionStorage({
      cwd: dir,
      signal: new AbortController().signal,
      report: () => {},
      observePath: async () => {},
    });
    const rejected = expect(result).rejects.toThrow("startup_status_timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await rejected;
  } finally {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects cancellation after prepared and exit zero while owned cleanup is pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-cleanup-abort-"));
  const entry = join(dir, "prepared.cjs");
  const databasePath = join(dir, "session.sqlite");
  const controller = new AbortController();
  const cleanupReleased = Promise.withResolvers<void>();
  const childClosed = Promise.withResolvers<void>();
  const preparedPaths = new Set<string>();
  const initializeServices = vi.fn();
  await writeFile(
    entry,
    `
    const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).once('line', () => {
      send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:1,databaseId:'db',databaseKind:'session',phase:'ready',elapsedMs:0}});
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    process.stdout.write(${JSON.stringify(startupProfileLine(dir))});
    send({method:'startup/storagePath',params:{path:${JSON.stringify(databasePath)}}});
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    supportsStorageStartup: true,
    storagePreparation: { kind: "command" },
  });
  // 在真实 spawn 返回时订阅 close，不能等异步身份查询完成后再补订阅。
  cleanupControl.spawned = (child) => {
    cleanupControl.spawned = undefined;
    child.once("close", () => childClosed.resolve());
  };
  cleanupControl.run = async () => {
    await cleanupReleased.promise;
    return { remainingPids: [] };
  };
  try {
    const result = prepareSessionStorage({
      cwd: dir,
      signal: controller.signal,
      report: () => {},
      observePath: async () => {},
      preparedPaths,
    }).then(initializeServices);
    const rejected = expect(result).rejects.toThrow("cancelled during cleanup");
    await childClosed.promise;
    // 修复回归：进程正常退出不能提前解除仍在清理屏障内的取消。
    controller.abort(new Error("cancelled during cleanup"));
    cleanupReleased.resolve();
    await rejected;
    expect(preparedPaths.size).toBe(0);
    expect(initializeServices).not.toHaveBeenCalled();
  } finally {
    cleanupReleased.resolve();
    cleanupControl.run = undefined;
    cleanupControl.spawned = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});

it("closes an ACK-waiting external stdin and reports a surviving root when identity discovery is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-unavailable-"));
  const entry = join(dir, "waiting.cjs");
  const eofPath = join(dir, "stdin-ended");
  const controller = new AbortController();
  const preparedPaths = new Set<string>();
  const initializeServices = vi.fn();
  const original = await vi.importActual<typeof StorageStartup>("@zcode/services/storage-startup");
  let ownedChild: ChildProcess | undefined;
  let cleanupResult: { remainingPids: number[] } | undefined;
  await writeFile(
    entry,
    `
    process.stdin.resume();
    process.stdin.once('end', () => require('node:fs').writeFileSync(${JSON.stringify(eofPath)}, 'EOF'));
    setInterval(() => {}, 1000);
    process.stdout.write(${JSON.stringify(startupProfileLine(dir))});
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(join(dir, "session.sqlite"))}}})+'\\n');
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    supportsStorageStartup: true,
    storagePreparation: { kind: "command" },
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  cleanupControl.unavailable = true;
  cleanupControl.run = async (child, options) => {
    ownedChild = child;
    // 测试仅缩短已有等待预算，不替换真实身份归属与残留判定。
    cleanupResult = await original.terminateProcessTreeAndWait(child, {
      ...options,
      forceAfterMs: 0,
      waitAfterForceMs: 100,
      windowsTaskkillTimeoutMs: 1,
    });
    return cleanupResult;
  };
  try {
    const result = prepareSessionStorage({
      cwd: dir,
      signal: controller.signal,
      report: () => {},
      observePath: async () => controller.abort(new Error("cancelled before ACK")),
      preparedPaths,
    }).then(initializeServices);
    await expect(result).rejects.toThrow("cancelled before ACK");
    expect(ownedChild?.stdin?.writableEnded).toBe(true);
    await vi.waitFor(async () => expect(await readFile(eofPath, "utf8")).toBe("EOF"));
    expect(cleanupResult?.remainingPids).toEqual([ownedChild?.pid]);
    expect(ownedChild?.exitCode).toBeNull();
    expect(preparedPaths.size).toBe(0);
    expect(initializeServices).not.toHaveBeenCalled();
  } finally {
    cleanupControl.unavailable = false;
    cleanupControl.run = undefined;
    vi.restoreAllMocks();
    if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      const exited = Promise.withResolvers<void>();
      ownedChild.once("exit", () => exited.resolve());
      ownedChild.kill("SIGKILL");
      await exited.promise;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["inherited", "options", "command"] as const)("prepares original workspace profiles with normal-launch argv, identity, and raw %s OMP environment", async (envSource) => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-profile-"));
  const entry = join(dir, "profile.cjs");
  const capture = join(dir, "launch.json");
  const originalPath = join(dir, "historical-project");
  const envRoot = join(dir, "environment-root");
  await writeFile(
    entry,
    `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    const profileIndex = argv.indexOf('--profile');
    const profile = profileIndex < 0 ? 'default' : argv[profileIndex + 1];
    fs.writeFileSync(process.env.CAPTURE, JSON.stringify({argv, identity: process.env.ZCODE_WORKSPACE_IDENTITY, root: process.env.OMP_CONFIG_ROOT, env: Object.fromEntries(['OMP_OFFLINE','PI_CONFIG_DIR','OMP_FUTURE_RAW_OPTION','OMP_FUTURE_EMPTY_OPTION'].map(key => [key, process.env[key]]))}));
    const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
    require('node:readline').createInterface({input:process.stdin}).once('line', () => {
      send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:1,databaseId:profile,databaseKind:'session',phase:'checking',elapsedMs:0}});
      send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:2,databaseId:profile,databaseKind:'session',phase:'ready',elapsedMs:0}});
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    send({method:'omp/startup/profile',params:{configRoot:process.env.OMP_CONFIG_ROOT,activeProfile:profile,storageScope:'scope:'+profile}});
    send({method:'startup/storagePath',params:{path:require('node:path').join(process.cwd(), profile + '.sqlite')}});
  `,
  );
  const command: StorageStartup.ZCodeAgentCommand = {
    command: process.execPath,
    args: [entry, "app-server", "--stdio", "--surface", "desktop"],
    env: { CAPTURE: capture },
    supportsStorageStartup: true,
    storagePreparation: { kind: "command" },
  };
  resolver.mockReturnValue(command);
  profileSettings.selections = {
    "remote:alpha": "alpha",
    "remote:beta": "beta",
    [originalPath]: "historical",
    [dir]: "wrong-fallback",
  };
  profileSettings.roots = {
    "remote:alpha": join(dir, "alpha-root"),
    "remote:beta": join(dir, "beta-root"),
    [originalPath]: join(dir, "historical-root"),
    [dir]: join(dir, "wrong-fallback-root"),
  };
  const inheritedEnv = {
    OMP_OFFLINE: " \tTrUe \n",
    PI_CONFIG_DIR: " \t.pi-inherited ",
    OMP_FUTURE_RAW_OPTION: " \tInherited Value \n",
    OMP_FUTURE_EMPTY_OPTION: "",
  };
  const optionEnv = {
    OMP_OFFLINE: " \tFaLsE \n",
    PI_CONFIG_DIR: " \t.pi-options ",
    OMP_FUTURE_RAW_OPTION: " \tOptions Value \n",
    OMP_FUTURE_EMPTY_OPTION: "",
  };
  const commandEnv = {
    OMP_OFFLINE: "",
    PI_CONFIG_DIR: " \t.pi-command ",
    OMP_FUTURE_RAW_OPTION: " \tCommand Value \n",
    OMP_FUTURE_EMPTY_OPTION: "",
  };
  for (const [key, value] of Object.entries(inheritedEnv)) vi.stubEnv(key, value);
  if (envSource === "command") command.env = { ...command.env, ...commandEnv };
  const optionsEnv = envSource === "inherited" ? {} : optionEnv;
  const expectedEnv =
    envSource === "command" ? commandEnv : envSource === "options" ? optionEnv : inheritedEnv;
  const cases = [
    {
      target: { workspacePath: dir, workspaceIdentity: "remote:alpha" },
      profile: "alpha",
      root: join(dir, "alpha-root"),
    },
    {
      target: { workspacePath: dir, workspaceIdentity: "remote:beta" },
      profile: "beta",
      root: join(dir, "beta-root"),
    },
    {
      target: { workspacePath: originalPath },
      profile: "historical",
      root: join(dir, "historical-root"),
    },
    { target: { workspacePath: join(dir, "unknown-history") }, profile: undefined, root: envRoot },
  ];
  try {
    for (const { target, profile, root } of cases) {
      const paths: string[] = [];
      await prepareSessionStorage({
        cwd: dir,
        workspaceTarget: target,
        env: { ...optionsEnv, OMP_CONFIG_ROOT: envRoot },
        signal: new AbortController().signal,
        report: () => {},
        observePath: async (path) => {
          paths.push(path);
        },
      });
      const normalCommand = applyOmpProfileToCommand(command, profile);
      const launch = JSON.parse(await readFile(capture, "utf8"));
      expect(launch.argv).toEqual([
        ...normalCommand.args!.slice(1),
        "--cwd",
        dir,
        "--prepare-storage",
      ]);
      expect(launch.identity).toBe(target.workspaceIdentity);
      expect(launch.root).toBe(root);
      expect(launch.env).toEqual(expectedEnv);
      expect(paths).toEqual([
        getTasksIndexDatabasePath({ configRoot: root, profileId: profile ?? "default" }),
        join(dir, `${profile ?? "default"}.sqlite`),
      ]);
      expect(resolver).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ...target,
          workspaceKey: target.workspaceIdentity?.trim() || target.workspacePath,
          env: expect.objectContaining({ OMP_CONFIG_ROOT: root }),
        }),
      );
    }
  } finally {
    profileSettings.selections = {};
    profileSettings.roots = {};
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects a pinned command root conflicting with the original workspace's inherited root before spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-pinned-root-"));
  const target = { workspacePath: dir, workspaceIdentity: "remote:root-owner" };
  const inheritedRoot = join(dir, "actual-root");
  const spawned = vi.fn();
  const observed = vi.fn(async () => {});
  profileSettings.roots = { [target.workspaceIdentity]: inheritedRoot };
  resolver.mockReturnValue({
    command: process.execPath,
    args: ["app-server"],
    env: { OMP_CONFIG_ROOT: join(dir, "conflicting-root") },
    supportsStorageStartup: true,
    storagePreparation: { kind: "command" },
  });
  cleanupControl.spawned = spawned;
  try {
    await expect(
      prepareSessionStorage({
        cwd: dir,
        workspaceTarget: target,
        signal: new AbortController().signal,
        report: () => {},
        observePath: observed,
      }),
    ).rejects.toMatchObject({ code: "omp.profileRootPinned" });
    expect(resolver).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...target,
        workspaceKey: target.workspaceIdentity,
        env: expect.objectContaining({ OMP_CONFIG_ROOT: inheritedRoot }),
      }),
    );
    expect(spawned).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
  } finally {
    profileSettings.roots = {};
    cleanupControl.spawned = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["ready", "failed"])(
  "waits for the native profile's scoped index before ACK and propagates index preparation %s",
  async (outcome) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-index-order-"));
    const configRoot = join(dir, "native-config");
    const indexPath = getTasksIndexDatabasePath({ configRoot, profileId: "actual" });
    const sessionPath = join(dir, "native-session.sqlite");
    const ackPath = join(dir, "ack.json");
    const entry = join(dir, "index-order.cjs");
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const preparedPaths = new Set<string>();
    const observed: string[] = [];
    const prepareIndex = vi.fn(async (path: string) => {
      expect(path).toBe(indexPath);
      entered.resolve();
      await released.promise;
      if (outcome === "failed") throw new Error("index preparation failed");
    });
    indexPreparation.run = prepareIndex;
    await writeFile(
      entry,
      `
      const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
      require('node:readline').createInterface({input:process.stdin}).once('line', line => {
        require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, line);
        send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'a',sequence:1,databaseId:'session',databaseKind:'session',phase:'ready',elapsedMs:0}});
        process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
      });
      process.stdout.write(${JSON.stringify(startupProfileLine(configRoot, "actual"))});
      send({method:'startup/storagePath',params:{path:${JSON.stringify(sessionPath)}}});
    `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [entry],
      supportsStorageStartup: true,
      storagePreparation: { kind: "command" },
    });
    try {
      const result = prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        preparedPaths,
        report: () => {},
        observePath: async (path) => {
          observed.push(path);
        },
      });
      const completion =
        outcome === "failed" ? expect(result).rejects.toThrow("index preparation failed") : result;
      await entered.promise;
      expect(observed).toEqual([indexPath]);
      expect(preparedPaths.size).toBe(0);
      await expect(readFile(ackPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      released.resolve();
      await completion;
      expect(prepareIndex).toHaveBeenCalledOnce();
      if (outcome === "ready") {
        expect(JSON.parse(await readFile(ackPath, "utf8"))).toEqual({
          method: "startup/storagePathReady",
          reuse: false,
        });
        expect(observed).toEqual([indexPath, sessionPath]);
        expect(preparedPaths).toEqual(new Set([indexPath, sessionPath]));
      } else {
        await expect(readFile(ackPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(observed).toEqual([indexPath]);
        expect(preparedPaths.size).toBe(0);
      }
    } finally {
      released.resolve();
      indexPreparation.run = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(["missing", "duplicate", "relative-root", "unknown-field", "bad-profile", "empty-scope"])(
  "rejects %s native startup profile facts without ACK or preparing an index",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-profile-frame-"));
    const entry = join(dir, "invalid-profile.cjs");
    const ackPath = join(dir, "ack.json");
    const params = {
      configRoot: mode === "relative-root" ? "relative/root" : dir,
      activeProfile: mode === "bad-profile" ? 7 : null,
      storageScope: mode === "empty-scope" ? "" : "actual-scope",
      ...(mode === "unknown-field" ? { unexpected: true } : {}),
    };
    const notification = JSON.stringify({ method: "omp/startup/profile", params }) + "\n";
    const facts = mode === "missing" ? "" : notification.repeat(mode === "duplicate" ? 2 : 1);
    await writeFile(
      entry,
      `
      require('node:readline').createInterface({input:process.stdin}).once('line', line => {
        require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, line);
        process.exit(9);
      });
      process.stdout.write(${JSON.stringify(facts)});
      process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(join(dir, "session.sqlite"))}}})+'\\n');
    `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [entry],
      supportsStorageStartup: true,
      storagePreparation: { kind: "command" },
    });
    const observed = vi.fn(async () => {});
    const indexCount = indexPreparation.paths.length;
    const preparedPaths = new Set<string>();
    try {
      await expect(
        prepareSessionStorage({
          cwd: dir,
          signal: new AbortController().signal,
          report: () => {},
          observePath: observed,
          preparedPaths,
        }),
      ).rejects.toThrow(
        mode === "missing"
          ? "unsupported_runtime"
          : mode === "duplicate" || mode === "relative-root"
            ? "transport_closed"
            : undefined,
      );
      expect(observed).not.toHaveBeenCalled();
      expect(indexPreparation.paths).toHaveLength(indexCount);
      expect(preparedPaths.size).toBe(0);
      await expect(readFile(ackPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
