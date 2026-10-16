import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(
  process.platform,
  "win32",
  "This smoke is intentionally Windows-only; never run it in Linux/WSL",
);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("tsup/package.json"))("esbuild");
const root = await mkdtemp(join(tmpdir(), "ompcode-offline-electron-"));
const helper = join(root, "helpers.cjs");
await build({
  stdin: {
    contents: [
      "export * from './src/main/offlineDesktopPaths.ts';",
      "export * from './src/main/offlineBrowserState.ts';",
      "export * from './src/main/offlineDataBackupLifecycle.ts';",
    ].join("\n"),
    resolveDir: desktop,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: helper,
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = [
  fileURLToPath(new URL("./offlineDesktop.windows-smoke.cjs", import.meta.url)),
  root,
  helper,
  join(desktop, "out/main/offlineDataBackupWorker.js"),
];
const child = spawn(require("electron"), args, {
  cwd: desktop,
  env,
  windowsHide: true,
  stdio: "inherit",
});
const exit = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code));
});
await writeFile(join(root, "launcher-result.json"), JSON.stringify({ exit, root }));
console.log(`Isolated Windows smoke evidence: ${root}`);
assert.equal(exit, 0);
