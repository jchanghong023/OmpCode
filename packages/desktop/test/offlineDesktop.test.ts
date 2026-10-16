import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOfflineDesktopElectronPaths,
  initializeOfflineDesktopEnvironment,
  resolveOfflineDesktopPaths,
} from "../src/main/offlineDesktopPaths.js";
import {
  createOfflineDataBackupLifecycle,
  OFFLINE_DATA_BACKUP_PERIOD_MS,
} from "../src/main/offlineDataBackupLifecycle.js";
import {
  captureOfflineBrowserState,
  persistOfflineBrowserState,
} from "../src/main/offlineBrowserState.js";
import { applyEarlyChromiumHardwareAccelerationBootstrap } from "../src/main/desktopChromiumHardwareAccelerationBootstrap.js";
import {
  runOfflineDataBackupWorker,
  type OfflineBackupWorkerHandle,
} from "../src/main/offlineDataBackupWorkerClient.js";

const options = {
  home: "/home/isolated",
  env: { OMP_OFFLINE: " YES " },
  platform: "linux" as const,
  uid: 123,
  hostname: "isolated-host",
};
const paths = resolveOfflineDesktopPaths("Isolated Desktop", options)!;

test("default offline root is selected without OMP_CONFIG_ROOT; Windows and nonoffline do nothing", () => {
  assert.equal(paths.roots.persistentRoot, "/home/isolated/.ompcode");
  assert.match(paths.roots.runtimeRoot, /^\/dev\/shm\/ompcode-123-[a-f0-9]{64}\/\.ompcode$/);
  assert.equal(resolveOfflineDesktopPaths("Desktop", { ...options, platform: "win32" }), undefined);
  assert.equal(
    resolveOfflineDesktopPaths("Desktop", { ...options, env: { OMP_OFFLINE: "off" } }),
    undefined,
  );
  const overridden = resolveOfflineDesktopPaths("Desktop", {
    ...options,
    env: { OMP_OFFLINE: "1", OMP_CONFIG_ROOT: "/nfs/custom", PI_CONFIG_DIR: "/ignored" },
  })!;
  assert.equal(overridden.roots.persistentRoot, "/nfs/custom_ompcode");
});

test("early initialization touches local directories only and preserves original OMP identity", () => {
  const env = {
    OMP_OFFLINE: "1",
    OMP_CONFIG_ROOT: "/unavailable-nfs/omp",
    PI_CONFIG_DIR: "legacy",
  } as NodeJS.ProcessEnv;
  const touched: string[] = [];
  initializeOfflineDesktopEnvironment(paths, env, (root) => touched.push(root.runtimeRoot));
  assert.ok(touched.length > 5);
  assert.ok(
    touched.every(
      (path) => path === paths.roots.runtimeRoot || path.startsWith(`${paths.roots.runtimeRoot}/`),
    ),
  );
  assert.ok(!touched.includes(paths.roots.persistentRoot));
  assert.equal(env.OMP_CONFIG_ROOT, "/unavailable-nfs/omp");
  assert.equal(env.PI_CONFIG_DIR, "legacy");
  assert.equal(env.ZCODE_HOME, paths.roots.runtimeRoot);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(env[key], paths.temp);
  assert.equal(env.XDG_CACHE_HOME, paths.cache);
  const actual: Record<string, string> = {};
  applyOfflineDesktopElectronPaths(
    {
      setPath: (key, path) => {
        actual[key] = path;
      },
      commandLine: {
        appendSwitch: (key, value) => {
          actual[key] = value;
        },
      },
    },
    paths,
  );
  for (const key of ["appData", "userData", "sessionData", "temp", "crashDumps", "logs"] as const)
    assert.equal(actual[key], paths[key]);
  assert.equal(actual["disk-cache-dir"], paths.cache);
});

test("readiness starts exactly one delayed ten-minute schedule, coalesces overlap, and aborts without waiting", async () => {
  let tick: (() => void) | undefined;
  let schedules = 0;
  let cancelled = 0;
  let runs = 0;
  let signal: AbortSignal | undefined;
  let finish!: (status: "completed") => void;
  const lifecycle = createOfflineDataBackupLifecycle({
    schedule: (callback, period) => {
      schedules++;
      assert.equal(period, OFFLINE_DATA_BACKUP_PERIOD_MS);
      tick = callback;
      return () => {
        cancelled++;
      };
    },
    run: (activeSignal) => {
      runs++;
      signal = activeSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    warn: () => assert.fail("quit does not warn"),
  });
  assert.equal(runs, 0);
  assert.equal(schedules, 0);
  lifecycle.rendererReady();
  lifecycle.rendererReady();
  assert.equal(schedules, 1);
  assert.equal(runs, 0, "no startup backup or status read");
  tick!();
  await nextTurn();
  tick!();
  await nextTurn();
  assert.equal(runs, 1);
  lifecycle.stop();
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, 1);
  tick!();
  lifecycle.rendererReady();
  await nextTurn();
  assert.equal(runs, 1);
  finish("completed");
  await nextTurn();
});

test("warnings are bounded per failure streak; only completed backup resets them", async () => {
  let tick!: () => void;
  let warnings = 0;
  let result: "failure" | "busy" | "completed" = "failure";
  const lifecycle = createOfflineDataBackupLifecycle({
    schedule: (callback) => {
      tick = callback;
      return () => {};
    },
    run: async () => {
      if (result === "failure") throw new Error("sensitive/path");
      return result;
    },
    warn: () => {
      warnings++;
    },
  });
  lifecycle.rendererReady();
  tick();
  await nextTurn();
  tick();
  await nextTurn();
  assert.equal(warnings, 1);
  result = "busy";
  tick();
  await nextTurn();
  result = "failure";
  tick();
  await nextTurn();
  assert.equal(warnings, 1);
  result = "completed";
  tick();
  await nextTurn();
  result = "failure";
  tick();
  await nextTurn();
  assert.equal(warnings, 2);
  lifecycle.stop();
});

test("missing live renderer rejects instead of publishing an empty browser backup", async () => {
  const snapshotOptions = {
    relativePath: "electron/Isolated Desktop/first-party-browser-state.json",
  };
  for (const sources of [
    [],
    [
      {
        session: {},
        getURL: () => assert.fail("destroyed renderer must not be queried"),
        isDestroyed: () => true,
        executeJavaScript: async () => assert.fail("destroyed renderer must not be queried"),
      },
    ],
  ]) {
    await assert.rejects(
      captureOfflineBrowserState(sources, new AbortController().signal, snapshotOptions),
      /unavailable/,
    );
  }
});

test("browser capture reuses a shared origin without losing other origins", async () => {
  const sharedSession = {};
  const appOrigin = "http://127.0.0.1:47101";
  const otherOrigin = "http://127.0.0.1:47102";
  const source = (origin: string, session: object, value: string) => ({
    session,
    isDestroyed: () => false,
    getURL: () => `${origin}/workspace`,
    executeJavaScript: async () => ({
      origin,
      localStorage: [["draft", value]],
    }),
  });
  const duplicate = source(appOrigin, sharedSession, "unreachable");
  duplicate.executeJavaScript = async () =>
    assert.fail("shared storage must only be exported once");
  const files = await captureOfflineBrowserState(
    [
      source(appOrigin, sharedSession, "first draft"),
      duplicate,
      source(otherOrigin, sharedSession, "other draft"),
    ],
    new AbortController().signal,
    { relativePath: "browser.json" },
  );
  assert.deepEqual(JSON.parse(files[0]!.content), {
    version: 1,
    origins: [
      { origin: appOrigin, localStorage: [["draft", "first draft"]] },
      { origin: otherOrigin, localStorage: [["draft", "other draft"]] },
    ],
    cookieSessions: [],
  });
});

test("valid shared storage survives redundant window closure and same-origin routes", async () => {
  const origin = "http://127.0.0.1:47101";
  for (const [target, nextUrl] of [
    ["duplicate", undefined],
    ["duplicate", `${origin}/workspace#another-view`],
    ["duplicate", `${origin}/other-route?view=history`],
    ["representative", `${origin}/workspace#another-view`],
    ["representative", `${origin}/other-route?view=history`],
  ] as const) {
    const session = {};
    let representativeUrl = `${origin}/workspace`;
    let duplicateUrl = representativeUrl;
    let duplicateClosed = false;
    const representative = {
      session,
      isDestroyed: () => false,
      getURL: () => representativeUrl,
      executeJavaScript: async () => {
        if (target === "representative") representativeUrl = nextUrl!;
        else if (nextUrl === undefined) duplicateClosed = true;
        else duplicateUrl = nextUrl;
        return { origin, localStorage: [["draft", "saved shared draft"]] };
      },
    };
    const duplicate = {
      get session() {
        assert.equal(duplicateClosed, false, "destroyed webContents properties are unavailable");
        return session;
      },
      isDestroyed: () => duplicateClosed,
      getURL: () => duplicateUrl,
      executeJavaScript: async () => assert.fail("shared storage was already selected"),
    };
    const files = await captureOfflineBrowserState(
      [representative, duplicate],
      new AbortController().signal,
      { relativePath: "browser.json" },
    );
    assert.deepEqual(JSON.parse(files[0]!.content).origins, [
      { origin, localStorage: [["draft", "saved shared draft"]] },
    ]);
  }
});

test("skipped windows cannot introduce uncovered origins and representatives cannot disappear", async () => {
  const origin = "http://127.0.0.1:47101";
  for (const action of ["duplicate-origin", "representative-close"] as const) {
    const session = {};
    let representativeClosed = false;
    let duplicateUrl = `${origin}/workspace`;
    await assert.rejects(
      captureOfflineBrowserState(
        [
          {
            session,
            isDestroyed: () => representativeClosed,
            getURL: () => `${origin}/workspace`,
            executeJavaScript: async () => {
              if (action === "duplicate-origin") duplicateUrl = "http://127.0.0.1:47102/new-origin";
              else representativeClosed = true;
              return { origin, localStorage: [["draft", "saved"]] };
            },
          },
          {
            session,
            isDestroyed: () => false,
            getURL: () => duplicateUrl,
            executeJavaScript: async () => assert.fail("duplicate was already selected"),
          },
        ],
        new AbortController().signal,
        { relativePath: "browser.json" },
      ),
      /offline_browser_state_changed/,
    );
  }
});

test("opaque file capture permits fragments but rejects a different document", async () => {
  for (const nextUrl of ["file:///isolated.html#history", "file:///different.html"]) {
    let url = "file:///isolated.html";
    const capture = captureOfflineBrowserState(
      [
        {
          session: {},
          isDestroyed: () => false,
          getURL: () => url,
          executeJavaScript: async () => {
            url = nextUrl;
            return { origin: "null", localStorage: [["draft", "file draft"]] };
          },
        },
      ],
      new AbortController().signal,
      { relativePath: "browser.json" },
    );
    if (nextUrl.endsWith("#history")) {
      const files = await capture;
      assert.deepEqual(JSON.parse(files[0]!.content).origins, [
        { origin: "null", localStorage: [["draft", "file draft"]] },
      ]);
    } else await assert.rejects(capture, /offline_browser_state_changed/);
  }
});

test("other sessions and opaque origins are not skipped, and navigation invalidates capture", async () => {
  const snapshotOptions = { relativePath: "browser.json" };
  const origin = "http://127.0.0.1:47101";
  const first = {
    session: {},
    isDestroyed: () => false,
    getURL: () => `${origin}/workspace`,
    executeJavaScript: async () => ({ origin, localStorage: [["draft", "saved"]] }),
  };
  for (const second of [
    { ...first, session: {} },
    { ...first, getURL: () => "file:///isolated.html" },
  ]) {
    second.executeJavaScript = async () => {
      throw new Error("independent storage is unavailable");
    };
    await assert.rejects(
      captureOfflineBrowserState([first, second], new AbortController().signal, snapshotOptions),
      /independent storage is unavailable/,
    );
  }
  let url = first.getURL();
  await assert.rejects(
    captureOfflineBrowserState(
      [
        {
          ...first,
          getURL: () => url,
          executeJavaScript: async () => {
            url = "http://127.0.0.1:47102/new-origin";
            return { origin, localStorage: [["draft", "saved"]] };
          },
        },
      ],
      new AbortController().signal,
      snapshotOptions,
    ),
    /offline_browser_state_changed/,
  );
});

class FakeBackupWorker extends EventEmitter implements OfflineBackupWorkerHandle {
  threadId = 42;
  terminated = 0;
  unref() {}
  postMessage() {}
  async terminate() {
    this.terminated++;
    return 1;
  }
}

test("worker completes only after exit and exact captured lease cleanup", async () => {
  const worker = new FakeBackupWorker();
  let release!: () => void;
  let settled = false;
  const pending = runOfflineDataBackupWorker(
    { roots: paths.roots, logicalFiles: [] },
    new AbortController().signal,
    {
      createWorker: () => worker,
      releaseLease: async (roots, owner) => {
        assert.equal(roots, paths.roots);
        assert.deepEqual(owner, { pid: process.pid, threadId: 42 });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    },
  ).then((status) => {
    settled = true;
    return status;
  });
  worker.emit("message", { type: "done", status: "completed" });
  await nextTurn();
  assert.equal(settled, false);
  worker.threadId = -1;
  worker.emit("exit", 0);
  await nextTurn();
  assert.equal(settled, false);
  release();
  assert.equal(await pending, "completed");
});

test("quit terminates immediately and a failed worker cannot appear successful", async () => {
  const worker = new FakeBackupWorker();
  const controller = new AbortController();
  const pending = runOfflineDataBackupWorker(
    { roots: paths.roots, logicalFiles: [] },
    controller.signal,
    { createWorker: () => worker, releaseLease: async () => {} },
  );
  controller.abort();
  assert.equal(worker.terminated, 1);
  worker.emit("exit", 1);
  await assert.rejects(pending, /aborted/);
  const unexpected = new FakeBackupWorker();
  const failed = runOfflineDataBackupWorker(
    { roots: paths.roots, logicalFiles: [] },
    new AbortController().signal,
    { createWorker: () => unexpected, releaseLease: async () => {} },
  );
  unexpected.emit("exit", 0);
  await assert.rejects(failed, /exited/);
});

test("browser sidecar survives subsequent rounds and replaces complete JSON atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-browser-state-"));
  try {
    await persistOfflineBrowserState(directory, JSON.stringify({ version: 1, value: "first" }));
    await persistOfflineBrowserState(directory, JSON.stringify({ version: 1, value: "second" }));
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "first-party-browser-state.json"), "utf8")),
      { version: 1, value: "second" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("earliest hardware settings read follows the configured application root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-hardware-settings-"));
  const original = process.env.OMP_CONFIG_ROOT;
  const offline = process.env.OMP_OFFLINE;
  try {
    process.env.OMP_CONFIG_ROOT = join(directory, "omp");
    delete process.env.OMP_OFFLINE;
    const config = join(`${process.env.OMP_CONFIG_ROOT}_ompcode`, "v2");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "setting.json"),
      JSON.stringify({ desktopChromiumHardwareAccelerationEnabled: false }),
    );
    let disabled = false;
    const enabled = applyEarlyChromiumHardwareAccelerationBootstrap({
      disableHardwareAcceleration() {
        disabled = true;
      },
    });
    assert.equal(enabled, false);
    assert.equal(disabled, true);
  } finally {
    if (original === undefined) delete process.env.OMP_CONFIG_ROOT;
    else process.env.OMP_CONFIG_ROOT = original;
    if (offline === undefined) delete process.env.OMP_OFFLINE;
    else process.env.OMP_OFFLINE = offline;
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics keep last-success solely in the lifecycle and never expose failure messages", async () => {
  let tick!: () => void;
  let time = new Date("2026-10-16T00:00:00.000Z");
  let result: "completed" | "busy" | "failure" = "completed";
  let failureCode = "ENOSPC";
  const events: Array<{ phase: string; at: string; lastSuccessfulAt?: string; code?: string }> = [];
  const lifecycle = createOfflineDataBackupLifecycle({
    schedule: (callback) => {
      tick = callback;
      return () => {};
    },
    now: () => time,
    diagnostic: (event) => events.push(event),
    run: async () => {
      if (result === "failure")
        throw Object.assign(new Error("/private/nfs/sensitive-content"), { code: failureCode });
      return result;
    },
    warn: () => {},
  });
  assert.deepEqual(events, []);
  lifecycle.rendererReady();
  assert.deepEqual(events, [], "readiness does not inspect last-success or emit a round");
  tick();
  await nextTurn();
  const success = time.toISOString();
  assert.deepEqual(events, [
    { phase: "started", at: success, lastSuccessfulAt: undefined },
    { phase: "completed", at: success, lastSuccessfulAt: success },
  ]);
  time = new Date("2026-10-16T00:10:00.000Z");
  result = "busy";
  tick();
  await nextTurn();
  assert.equal(events.at(-1)?.lastSuccessfulAt, success);
  result = "failure";
  tick();
  await nextTurn();
  assert.deepEqual(events.at(-1), {
    phase: "failed",
    at: time.toISOString(),
    lastSuccessfulAt: success,
    code: "ENOSPC",
  });
  failureCode = "/private/nfs/sensitive-code";
  tick();
  await nextTurn();
  assert.equal(events.at(-1)?.code, "BACKUP_FAILED");
  assert.ok(!JSON.stringify(events).includes("private"));
  lifecycle.stop();
});

test("worker protocol forwards only bounded symbolic error codes", async () => {
  for (const [code, expected] of [
    ["SQLITE_BUSY", "SQLITE_BUSY"],
    ["/private/nfs/content", "BACKUP_FAILED"],
    ["X".repeat(65), "BACKUP_FAILED"],
  ]) {
    const worker = new FakeBackupWorker();
    const pending = runOfflineDataBackupWorker(
      { roots: paths.roots, logicalFiles: [] },
      new AbortController().signal,
      { createWorker: () => worker, releaseLease: async () => {} },
    );
    worker.emit("message", { type: "error", code });
    worker.emit("exit", 0);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, expected);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  }
});
