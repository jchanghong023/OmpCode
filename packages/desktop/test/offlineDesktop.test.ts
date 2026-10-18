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
  type OfflineDataBackupLifecycleState,
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
  assert.ok(touched.every((path) => path.startsWith("/dev/shm/")));
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

test("backup state reads are immutable memory-only projections and readiness commits before notification", () => {
  let clockReads = 0;
  let schedules = 0;
  const changes: OfflineDataBackupLifecycleState[] = [];
  const order: string[] = [];
  const lifecycle = createOfflineDataBackupLifecycle({
    now: () => {
      clockReads++;
      return new Date("2026-10-16T00:00:00.000Z");
    },
    schedule: (_callback, period) => {
      schedules++;
      order.push("schedule");
      assert.equal(period, OFFLINE_DATA_BACKUP_PERIOD_MS);
      return () => {};
    },
    onStateChanged: (state) => {
      assert.strictEqual(lifecycle.getState(), state, "state is committed before notification");
      changes.push(state);
      order.push(`state:${state.phase}`);
    },
    run: async () => assert.fail("reading or admitting a renderer must not run a backup"),
    warn: () => assert.fail("reading state must not warn"),
    diagnostic: () => assert.fail("reading state must not emit a round diagnostic"),
  });
  const initial = lifecycle.getState();
  assert.deepEqual(initial, {
    revision: 0,
    phase: "waiting",
    periodMs: OFFLINE_DATA_BACKUP_PERIOD_MS,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextScheduledAt: null,
    code: null,
  });
  for (let read = 0; read < 3; read++) assert.strictEqual(lifecycle.getState(), initial);
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Reflect.set(initial, "phase", "failed"), false);
  assert.equal(clockReads, 0);
  assert.equal(schedules, 0);
  assert.deepEqual(changes, []);
  lifecycle.rendererReady();
  lifecycle.rendererReady();
  assert.equal(schedules, 1);
  assert.equal(clockReads, 1);
  assert.deepEqual(order, ["state:waiting", "schedule"]);
  assert.equal(lifecycle.getState().revision, 1);
  assert.equal(lifecycle.getState().nextScheduledAt, "2026-10-16T00:10:00.000Z");
  assert.equal(initial.nextScheduledAt, null, "old snapshots cannot change under a consumer");
  const waiting = lifecycle.getState();
  for (let read = 0; read < 3; read++) assert.strictEqual(lifecycle.getState(), waiting);
  assert.equal(clockReads, 1, "getState does not consult the clock or reschedule");
  lifecycle.stop();
  assert.equal(lifecycle.getState().nextScheduledAt, null);
  assert.equal(lifecycle.getState().revision, 2);
  const stopped = lifecycle.getState();
  lifecycle.stop();
  lifecycle.rendererReady();
  assert.strictEqual(lifecycle.getState(), stopped);
  assert.equal(schedules, 1);
});

test("running state precedes work; overlapping and delayed ticks keep the fixed schedule", async () => {
  let time = new Date("2026-10-16T00:00:00.000Z");
  let tick!: () => void;
  let finish!: (status: "completed") => void;
  let runs = 0;
  const changes: OfflineDataBackupLifecycleState[] = [];
  const lifecycle = createOfflineDataBackupLifecycle({
    now: () => time,
    schedule: (callback) => {
      tick = callback;
      return () => {};
    },
    onStateChanged: (state) => {
      assert.strictEqual(lifecycle.getState(), state);
      changes.push(state);
    },
    run: async () => {
      runs++;
      assert.equal(lifecycle.getState().phase, "running");
      assert.equal(changes.at(-1)?.phase, "running", "consumers are notified before work begins");
      return new Promise<"completed">((resolve) => {
        finish = resolve;
      });
    },
    warn: () => assert.fail("successful and overlapping rounds do not warn"),
  });
  lifecycle.rendererReady();
  time = new Date("2026-10-16T00:10:00.000Z");
  tick();
  assert.equal(runs, 0);
  assert.equal(lifecycle.getState().phase, "running", "the running state is synchronous");
  assert.equal(lifecycle.getState().lastAttemptAt, time.toISOString());
  assert.equal(lifecycle.getState().nextScheduledAt, "2026-10-16T00:20:00.000Z");
  await nextTurn();
  const admittedAt = lifecycle.getState().lastAttemptAt;
  time = new Date("2026-10-16T00:20:00.000Z");
  tick();
  assert.equal(lifecycle.getState().phase, "running");
  assert.equal(lifecycle.getState().lastAttemptAt, admittedAt);
  assert.equal(lifecycle.getState().nextScheduledAt, "2026-10-16T00:30:00.000Z");
  time = new Date("2026-10-16T00:45:00.000Z");
  tick();
  assert.equal(lifecycle.getState().nextScheduledAt, "2026-10-16T00:50:00.000Z");
  assert.equal(lifecycle.getState().lastSuccessfulAt, null);
  assert.equal(lifecycle.getState().phase, "running", "overlap is not an external busy result");
  assert.equal(runs, 1);
  time = new Date("2026-10-16T00:47:00.000Z");
  finish("completed");
  await nextTurn();
  assert.equal(lifecycle.getState().phase, "completed");
  assert.equal(lifecycle.getState().lastSuccessfulAt, time.toISOString());
  assert.equal(lifecycle.getState().nextScheduledAt, "2026-10-16T00:50:00.000Z");
  assert.deepEqual(
    changes.map((state) => state.revision),
    [1, 2, 3, 4, 5],
  );
  assert.equal(changes[1]?.phase, "running", "completed state does not mutate older revisions");
  lifecycle.stop();
});

test("stopping drops queued work and every late outcome", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    let tick!: () => void;
    let finish!: () => void;
    let runs = 0;
    let diagnostics = 0;
    let notifications = 0;
    const lifecycle = createOfflineDataBackupLifecycle({
      now: () => new Date("2026-10-16T00:00:00.000Z"),
      schedule: (callback) => {
        tick = callback;
        return () => {};
      },
      onStateChanged: () => {
        notifications++;
      },
      diagnostic: () => {
        diagnostics++;
      },
      run: async () => {
        runs++;
        return new Promise<"completed">((resolve, reject) => {
          finish = () => {
            if (outcome === "completed") resolve("completed");
            else reject(new Error("late failure"));
          };
        });
      },
      warn: () => assert.fail("quit must ignore late failure warnings"),
    });
    lifecycle.rendererReady();
    tick();
    await nextTurn();
    assert.equal(runs, 1);
    lifecycle.stop();
    const stopped = lifecycle.getState();
    const notificationsAtStop = notifications;
    assert.equal(stopped.nextScheduledAt, null);
    finish();
    await nextTurn();
    tick();
    lifecycle.rendererReady();
    assert.strictEqual(lifecycle.getState(), stopped);
    assert.equal(notifications, notificationsAtStop);
    assert.equal(diagnostics, 1, "only the pre-stop started diagnostic survives");
    assert.equal(runs, 1);
  }
  let tick!: () => void;
  const lifecycle = createOfflineDataBackupLifecycle({
    schedule: (callback) => {
      tick = callback;
      return () => {};
    },
    run: async () => assert.fail("a stopped queued round must never enter backup IO"),
    warn: () => assert.fail("a stopped queued round must never warn"),
    diagnostic: () => assert.fail("a stopped queued round must never emit diagnostics"),
  });
  lifecycle.rendererReady();
  tick();
  lifecycle.stop();
  const stopped = lifecycle.getState();
  await nextTurn();
  assert.strictEqual(lifecycle.getState(), stopped);
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
  assert.equal(lifecycle.getState().phase, "completed");
  assert.equal(lifecycle.getState().lastSuccessfulAt, success);
  assert.equal(lifecycle.getState().lastAttemptAt, success);
  assert.equal(lifecycle.getState().code, null);
  time = new Date("2026-10-16T00:10:00.000Z");
  result = "busy";
  tick();
  await nextTurn();
  assert.equal(events.at(-1)?.lastSuccessfulAt, success);
  assert.equal(lifecycle.getState().phase, "busy");
  assert.equal(lifecycle.getState().lastSuccessfulAt, success, "busy is not a successful backup");
  assert.equal(lifecycle.getState().lastAttemptAt, time.toISOString());
  assert.equal(lifecycle.getState().code, null);
  time = new Date("2026-10-16T00:20:00.000Z");
  result = "failure";
  tick();
  await nextTurn();
  assert.deepEqual(events.at(-1), {
    phase: "failed",
    at: time.toISOString(),
    lastSuccessfulAt: success,
    code: "ENOSPC",
  });
  assert.equal(lifecycle.getState().phase, "failed");
  assert.equal(lifecycle.getState().lastSuccessfulAt, success, "failure preserves success history");
  assert.equal(lifecycle.getState().lastAttemptAt, time.toISOString());
  assert.equal(lifecycle.getState().code, "ENOSPC");
  time = new Date("2026-10-16T00:30:00.000Z");
  failureCode = "/private/nfs/sensitive-code";
  tick();
  await nextTurn();
  assert.equal(events.at(-1)?.code, "BACKUP_FAILED");
  assert.equal(lifecycle.getState().code, "BACKUP_FAILED");
  assert.ok(!JSON.stringify(lifecycle.getState()).includes("private"));
  result = "busy";
  time = new Date("2026-10-16T00:40:00.000Z");
  tick();
  assert.equal(lifecycle.getState().phase, "running");
  assert.equal(lifecycle.getState().code, null, "a new attempt clears the previous failure code");
  await nextTurn();
  assert.equal(lifecycle.getState().phase, "busy");
  assert.equal(lifecycle.getState().lastSuccessfulAt, success);
  result = "completed";
  time = new Date("2026-10-16T00:50:00.000Z");
  tick();
  await nextTurn();
  assert.equal(lifecycle.getState().phase, "completed");
  assert.equal(lifecycle.getState().lastSuccessfulAt, time.toISOString());
  assert.equal(lifecycle.getState().code, null);
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
