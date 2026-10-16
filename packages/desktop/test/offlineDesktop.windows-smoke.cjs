const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { Worker } = require("node:worker_threads");
const { app, BrowserWindow } = require("electron");
const [root, helper, workerPath] = process.argv.slice(2);
const {
  applyOfflineDesktopElectronPaths,
  initializeOfflineDesktopEnvironment,
  resolveOfflineDesktopPaths,
  captureOfflineBrowserState,
  persistOfflineBrowserState,
  createOfflineDataBackupLifecycle,
} = require(helper);

assert.equal(process.platform, "win32");
assert.equal(
  resolveOfflineDesktopPaths("Windows stays unchanged", { env: { OMP_OFFLINE: "1" } }),
  undefined,
);
const runtimeRoot = join(root, "runtime");
const persistentRoot = join(root, "persistent");
const userData = join(runtimeRoot, "electron", "Isolated Smoke");
const paths = {
  roots: { runtimeRoot, persistentRoot, domainId: "windows-electron-smoke" },
  appData: join(runtimeRoot, "electron"),
  userData,
  sessionData: join(userData, "session"),
  cache: join(runtimeRoot, "cache"),
  temp: join(runtimeRoot, "tmp"),
  crashDumps: join(runtimeRoot, "v2", "crash-dumps"),
  logs: join(runtimeRoot, "v2", "logs"),
};
// Explicit helper injection only in this fixture; production has no platform/root bypass environment.
initializeOfflineDesktopEnvironment(paths, process.env, ({ runtimeRoot: directory }) =>
  fs.mkdirSync(directory, { recursive: true }),
);
applyOfflineDesktopElectronPaths(app, paths);
app.setName("OmpCode Isolated Offline Smoke");
app.commandLine.appendSwitch("remote-debugging-port", "0");
let lifecycle;
app.on("before-quit", () => lifecycle?.stop());

void app
  .whenReady()
  .then(async () => {
    for (const name of ["appData", "userData", "sessionData", "temp", "crashDumps", "logs"])
      assert.equal(app.getPath(name), paths[name]);
    assert.equal(process.env.TMPDIR, paths.temp);
    assert.equal(app.commandLine.getSwitchValue("disk-cache-dir"), paths.cache);
    const html = join(root, "first-party.html");
    fs.writeFileSync(html, "<html><body>Offline storage isolated smoke</body></html>");
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await win.loadFile(html);
    await win.webContents.executeJavaScript(
      "localStorage.setItem('zcode-theme','zai-dark'); localStorage.setItem('smoke','persistent logical state')",
    );
    await win.webContents.session.cookies.set({
      url: "https://offline-smoke.invalid",
      name: "persistent",
      value: "logical-cookie",
      expirationDate: Date.now() / 1000 + 86400,
    });
    await win.webContents.session.cookies.set({
      url: "https://offline-smoke.invalid",
      name: "session-only",
      value: "not-a-persistent-cookie",
    });
    const sqlite = require("node:sqlite");
    const db = new sqlite.DatabaseSync(join(runtimeRoot, "v2", "smoke.db"));
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE smoke(value TEXT); INSERT INTO smoke VALUES ('committed WAL');",
    );
    let tick;
    let workers = 0;
    const round = Promise.withResolvers();
    lifecycle = createOfflineDataBackupLifecycle({
      schedule(callback, periodMs) {
        assert.equal(periodMs, 600000);
        tick = callback;
        return () => {};
      },
      async run(signal) {
        const files = await captureOfflineBrowserState([win.webContents], signal, {
          relativePath: "electron/Isolated Smoke/first-party-browser-state.json",
          cookieSessions: [{ partition: "default", session: win.webContents.session }],
        });
        await persistOfflineBrowserState(userData, files[0].content);
        workers++;
        const status = await new Promise((resolveStatus, reject) => {
          const worker = new Worker(workerPath, {
            workerData: { roots: paths.roots, logicalFiles: files },
          });
          let result;
          worker.on("message", (message) => {
            if (message.type === "done") result = message.status;
            else
              reject(
                Object.assign(new Error("Backup Worker reported failure"), { code: message.code }),
              );
          });
          worker.once("error", reject);
          worker.once("exit", (code) =>
            code === 0 && result
              ? resolveStatus(result)
              : reject(new Error(`Backup Worker exit ${code}`)),
          );
          signal.addEventListener(
            "abort",
            () => {
              void worker.terminate();
            },
            { once: true },
          );
        });
        round.resolve(status);
        return status;
      },
      warn() {
        round.reject(new Error("Unexpected backup warning"));
      },
      diagnostic(event) {
        if (event.phase === "failed") {
          round.reject(
            Object.assign(new Error(`Isolated backup failed: ${event.code}`), { code: event.code }),
          );
        }
      },
    });
    assert.equal(fs.existsSync(persistentRoot), false);
    lifecycle.rendererReady();
    lifecycle.rendererReady();
    assert.equal(workers, 0);
    assert.equal(
      fs.existsSync(persistentRoot),
      false,
      "readiness performs no persistent-root check or backup",
    );
    // Inject only the timer callback, not a production env bypass or reduced production period.
    tick();
    assert.equal(await round.promise, "completed");
    const domain = join(persistentRoot, `.offline-shm-backups-${paths.roots.domainId}`);
    const pointer = JSON.parse(fs.readFileSync(join(domain, "current.json"), "utf8"));
    const generation = join(domain, "generations", pointer.current);
    const browserState = JSON.parse(
      fs.readFileSync(
        join(generation, "data", "electron", "Isolated Smoke", "first-party-browser-state.json"),
        "utf8",
      ),
    );
    assert.ok(
      browserState.origins.some((origin) =>
        origin.localStorage.some(
          ([key, value]) => key === "smoke" && value === "persistent logical state",
        ),
      ),
    );
    assert.deepEqual(
      browserState.cookieSessions[0].cookies.map((cookie) => [cookie.name, cookie.value]),
      [["persistent", "logical-cookie"]],
    );
    const snapshot = new sqlite.DatabaseSync(join(generation, "data", "v2", "smoke.db"), {
      readOnly: true,
    });
    assert.equal(snapshot.prepare("SELECT value FROM smoke").get().value, "committed WAL");
    snapshot.close();
    db.close();
    lifecycle.stop();
    fs.writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify(
        {
          platform: process.platform,
          roots: paths.roots,
          paths,
          workers,
          current: pointer.current,
          logicalBrowserState: true,
          sqliteCommittedWal: true,
        },
        null,
        2,
      ),
    );
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    lifecycle?.stop();
    app.exit(1);
  });
