import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { commandOutput, startCommand, stopCommand } from "./test-gates-process.mjs";
import { readIsolationEvidence } from "../packages/desktop/test/ompCore.evidence.cjs";

const missing = (reason) => ({ status: "UNVERIFIED_MISSING_ENV", reason });
let packagingState;
let packagingCleanup;

async function snapshotPackagingState() {
  assert.equal(process.platform, "win32", "Local packaging validation is Windows-only");
  assert.ok(!packagingState, "Packaging must not overlap another packaging operation");
  const require = createRequire(resolve("packages/desktop/package.json"));
  const template = join(
    dirname(require.resolve("app-builder-lib/package.json")),
    "templates",
    "nsis",
    "installSection.nsh",
  );
  // Windows native-prebuild hook explicitly skips mutations; NSIS is the sole dependency write.
  packagingState = { template, bytes: await readFile(template) };
  console.log("Local packaging dependency snapshot: Windows NSIS template (1 file)");
}

export function restorePackagingState() {
  if (packagingCleanup) return packagingCleanup;
  packagingCleanup = Promise.resolve()
    .then(async () => {
      if (!packagingState) return;
      const { template, bytes } = packagingState;
      if (!(await readFile(template)).equals(bytes)) await writeFile(template, bytes);
      packagingState = undefined;
      console.log("Local packaging dependency restoration: complete (1 file)");
    })
    .finally(() => {
      packagingCleanup = undefined;
    });
  return packagingCleanup;
}

async function verifyIsolation(runtime, launcher) {
  assert.equal(launcher.exitCode, null, "Isolated GUI launcher must remain alive");
  assert.equal(launcher.signalCode, null, "Isolated GUI launcher must not be terminated");
  const isolation = await readIsolationEvidence(runtime.isolationEvidence);
  assert.equal(isolation.electronPid, runtime.electronPid, "Verify the current isolated Electron");
  assert.equal(isolation.mode, "hidden-native-windows");
  assert.equal(isolation.verified, true, isolation.failure ?? "Native window isolation failed");
  assert.ok(isolation.windows.length, "Native isolation requires actual window evidence");
  assert.ok(
    isolation.windows.every(
      (win) => win.visible === false && win.focused === false && win.focusable === false,
    ),
    "All native windows must remain hidden, unfocused, and nonfocusable",
  );
  const age = Date.now() - Date.parse(isolation.checkedAt);
  assert.ok(age >= 0 && age < 5000, "Native window evidence must be current, not a stale receipt");
  return { ...isolation, evidence: runtime.isolationEvidence };
}

async function fixtureStage(stage, context) {
  let fixture = context.guiProcesses.get(stage.file);
  if (!fixture) {
    fixture = {
      root: await mkdtemp(join(tmpdir(), "ompcode-core-gui-")),
      runId: `CORE_${Date.now()}`,
    };
    context.guiProcesses.set(stage.file, fixture);
  }
  const launcher = startCommand("node", ["packages/desktop/test/ompCore.launch.mjs"], {
    env: {
      OMP_E2E_ISOLATED_ROOT: fixture.root,
      OMP_E2E_STARTUP: stage.file === "ompStartup.gui.e2e.mjs" ? "1" : "0",
      OMP_RPC_BINARY_PATH: context.omp,
    },
  });
  try {
    const runtime = await new Promise((done, reject) => {
      const lines = createInterface({ input: launcher.stdout });
      lines.on("line", (line) => {
        if (line.startsWith("OMP_CORE_GUI_READY=")) {
          try {
            done(JSON.parse(line.slice("OMP_CORE_GUI_READY=".length)));
          } catch (error) {
            reject(error);
          }
        } else if (line.startsWith("OMP_CORE_GUI_FAILED=")) {
          reject(
            new Error(`${line.slice("OMP_CORE_GUI_FAILED=".length)}; evidence ${fixture.root}`),
          );
        } else console.log(line);
      });
      launcher.stderr.on("data", (data) => process.stderr.write(data));
      launcher.once("error", reject);
      launcher.once("close", (code) =>
        reject(
          new Error(`Core GUI launcher exited before readiness: ${code}; evidence ${fixture.root}`),
        ),
      );
    });
    console.log(`Core GUI evidence: ${fixture.root}`);
    await verifyIsolation(runtime, launcher);
    if (stage.phase === "recovery" && runtime.electronPid === fixture.pid)
      throw new Error("Recovery must use a new Electron process in the same isolated root");
    fixture.pid = runtime.electronPid;
    const result = await commandOutput(stage.command, stage.args, {
      env: {
        OMP_E2E_CDP_URL: runtime.endpoint,
        OMP_E2E_RENDERER_URL: runtime.rendererUrl,
        OMP_E2E_SCREENSHOT_URL: runtime.screenshotUrl,
        OMP_E2E_RUNTIME_MANIFEST: join(fixture.root, "runtime.json"),
        OMP_E2E_EVIDENCE_DIR: join(fixture.root, "evidence"),
        OMP_E2E_RUN_ID: fixture.runId,
        OMP_E2E_PHASE: stage.phase,
      },
    });
    const isolation = await verifyIsolation(runtime, launcher);
    console.log(`Core GUI isolation: ${JSON.stringify(isolation)}`);
    return { ...outcome(result), isolation };
  } finally {
    // 启动器一直存活；正常结束及总时限都能终止完整测试树，不能留下 detached supervisor。
    await stopCommand(launcher);
  }
}

function outcome(result) {
  return {
    status: result.code ? "FAIL" : result.skipped ? "UNVERIFIED_MISSING_ENV" : "PASS",
    exitCode: result.code,
    ...(result.skipped ? { reason: "Existing test reported skipped/unverified coverage" } : {}),
  };
}

export async function regularStage(stage, context) {
  if (stage.realOmp && !context.omp)
    return missing("No installed omp; real validation is not run and omp is not downloaded");
  if (stage.fixture) return await fixtureStage(stage, context);
  const env = { ...stage.env };
  let args = stage.args;
  let packagingOutput;
  if (stage.packaging) {
    packagingOutput = await mkdtemp(join(tmpdir(), "ompcode-local-package-"));
    args = [...args, `--config.directories.output=${packagingOutput}`];
    Object.assign(env, {
      ZCODE_DESKTOP_DIST_DIR: packagingOutput,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_LINK: "",
      WIN_CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      WIN_CSC_KEY_PASSWORD: "",
    });
    console.log(`Local unpacked packaging evidence: ${packagingOutput}`);
    await snapshotPackagingState();
  }
  if (stage.realOmp)
    Object.assign(env, {
      OMP_RPC_BINARY_PATH: context.omp,
      OMP_AGENT_SKIP_REAL_E2E: "0",
    });
  try {
    const result = outcome(await commandOutput(stage.command, args, { env }));
    return packagingOutput ? { ...result, packagingOutput } : result;
  } finally {
    if (stage.packaging) await restorePackagingState();
  }
}
