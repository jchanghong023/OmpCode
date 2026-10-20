import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { commandOutput, startCommand, stopCommand } from "./test-gates-process.mjs";
import { prepareStageEnvironment, stageOutcome } from "./test-gates-command-stage.mjs";
import { readIsolationEvidence } from "../packages/desktop/test/ompCore.evidence.cjs";
import { shutdownOwnedGui } from "../packages/desktop/test/ompCore.shutdown.mjs";
import { finalizeStoredInteractions } from "../packages/desktop/test/ompMockInteractions.assertions.mjs";
import { finalizeAgentsReceipt } from "../packages/desktop/test/ompAgentsAcceptance.lifecycle.mjs";
import { finalizeNativeReceipt } from "../packages/desktop/test/ompNativeAcceptance.lifecycle.mjs";

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

export async function fixtureStage(stage, context) {
  if (stage.realOmp && !context.omp)
    return {
      status: "UNVERIFIED_MISSING_ENV",
      reason: "No installed omp; local mock-model validation still requires the real binary",
    };
  const env = await prepareStageEnvironment(stage, context);
  const suite = stage.suite ?? (stage.file === "ompStartup.gui.e2e.mjs" ? "startup" : "identity");
  const log = (event) =>
    console.log(`[GUI] stage=${stage.id} suite=${suite} phase=${stage.phase} ${event}`);
  log("fixture preparation begin");
  const fixtureKey = `${stage.file}:${stage.suite ?? "identity"}`;
  let fixture = context.guiProcesses.get(fixtureKey);
  if (!fixture) {
    fixture = {
      root: await mkdtemp(join(tmpdir(), "ompcode-core-gui-")),
      runId: `CORE_${Date.now()}`,
    };
    context.guiProcesses.set(fixtureKey, fixture);
  }
  log(`fixture preparation complete evidence=${fixture.root}`);
  const launcher = startCommand("node", ["packages/desktop/test/ompCore.launch.mjs"], {
    stageId: stage.id,
    env: {
      ...env,
      OMP_E2E_ISOLATED_ROOT: fixture.root,
      OMP_E2E_STARTUP: stage.file === "ompStartup.gui.e2e.mjs" ? "1" : "0",
      OMP_E2E_SUITE: suite,
      OMP_E2E_STAGE_ID: stage.id,
      OMP_E2E_PHASE: stage.phase,
      OMP_RPC_BINARY_PATH: context.omp,
    },
  });
  let runtime;
  let stopWatching = () => {};
  log(`launcher readiness begin pid=${launcher.pid ?? "unavailable"}`);
  try {
    runtime = await new Promise((done, reject) => {
      const lines = createInterface({ input: launcher.stdout });
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        // Failure frames must reach the lifecycle owner before GUI teardown can hang.
        context.onFailure?.({ status: "FAIL", exitCode: 1, reason: error.message });
        reject(error);
      };
      const onError = (error) => fail(error);
      const onExit = (code, signal) =>
        fail(
          new Error(
            `Core GUI launcher exited unexpectedly: code=${code} signal=${signal}; evidence ${fixture.root}`,
          ),
        );
      launcher.on("error", onError);
      launcher.on("exit", onExit);
      stopWatching = () => {
        launcher.removeListener("error", onError);
        launcher.removeListener("exit", onExit);
        lines.close();
      };
      lines.on("line", (line) => {
        if (line.startsWith("OMP_CORE_GUI_READY=")) {
          try {
            done(JSON.parse(line.slice("OMP_CORE_GUI_READY=".length)));
          } catch (error) {
            fail(error);
          }
        } else if (
          line.startsWith("OMP_CORE_GUI_FAILED=") ||
          line.startsWith("OMP_CORE_GUI_EXITED=")
        ) {
          fail(new Error(`${line.slice(line.indexOf("=") + 1)}; evidence ${fixture.root}`));
        } else console.log(line);
      });
      launcher.stderr.on("data", (data) => process.stderr.write(data));
    });
    log(`launcher readiness complete pid=${runtime.electronPid} evidence=${fixture.root}`);
    await verifyIsolation(runtime, launcher);
    if (stage.phase !== "live" && runtime.electronPid === fixture.pid)
      throw new Error("Every continuation phase must use a new Electron process in the same root");
    fixture.pid = runtime.electronPid;
    log(`acceptance begin pid=${runtime.electronPid}`);
    const result = await commandOutput(stage.command, stage.args, {
      stageId: stage.id,
      clock: context.clock,
      failFast: true,
      captureOutput: false,
      onFailure: context.onFailure,
      env: {
        ...env,
        OMP_E2E_CDP_URL: runtime.endpoint,
        OMP_E2E_RENDERER_URL: runtime.rendererUrl,
        OMP_E2E_SCREENSHOT_URL: runtime.screenshotUrl,
        OMP_E2E_RUNTIME_MANIFEST: join(fixture.root, "runtime.json"),
        OMP_E2E_EVIDENCE_DIR: join(fixture.root, "evidence"),
        OMP_E2E_RUN_ID: fixture.runId,
        OMP_E2E_PHASE: stage.phase,
        OMP_E2E_SUITE: stage.suite,
      },
    });
    log(`acceptance complete pid=${runtime.electronPid} exitCode=${result.code}`);
    if (result.code) return stageOutcome(result);
    const isolation = await verifyIsolation(runtime, launcher);
    log(`isolation verified pid=${runtime.electronPid} evidence=${runtime.isolationEvidence}`);
    if (stage.file === "ompReviewedDefects.gui.e2e.mjs" && stage.phase === "live") {
      stopWatching();
      log(`shutdown begin pid=${runtime.electronPid} evidence=${fixture.root}`);
      await shutdownOwnedGui(runtime, launcher);
      log(`interaction finalization begin pid=${runtime.electronPid}`);
      await finalizeStoredInteractions(
        runtime,
        join(fixture.root, "evidence", `reviewed-defects-${fixture.runId}.json`),
      );
      log(`interaction finalization complete pid=${runtime.electronPid}`);
    }
    if (stage.file === "ompAgentsAcceptance.gui.e2e.mjs" && stage.phase === "live") {
      stopWatching();
      log(`shutdown begin pid=${runtime.electronPid} evidence=${fixture.root}`);
      await shutdownOwnedGui(runtime, launcher);
      log(`agents finalization begin pid=${runtime.electronPid}`);
      await finalizeAgentsReceipt(
        runtime,
        join(fixture.root, "evidence", `agents-${fixture.runId}.json`),
      );
      log(`agents finalization complete pid=${runtime.electronPid}`);
    }
    if (stage.file === "ompNativeAcceptance.gui.e2e.mjs" && stage.phase === "live") {
      stopWatching();
      log(`shutdown begin pid=${runtime.electronPid} evidence=${fixture.root}`);
      await shutdownOwnedGui(runtime, launcher);
      assert.ok(
        launcher.exitCode !== null || launcher.signalCode !== null,
        "Native receipt finalization requires the owned launcher to have exited",
      );
      assert.equal(launcher.exitCode, 0, "Native receipt requires a normal launcher exit");
      assert.equal(launcher.signalCode, null, "Native receipt must not follow signal termination");
      log(`native finalization begin pid=${runtime.electronPid}`);
      await finalizeNativeReceipt(
        runtime,
        join(fixture.root, "evidence", "native-acceptance-receipt.json"),
      );
      log(`native finalization complete pid=${runtime.electronPid}`);
    }
    return { ...stageOutcome(result), isolation };
  } catch (error) {
    // 隔离校验或恢复断言也必须先通知首失败，不能被后续的宽限关闭阻塞。
    context.onFailure?.({ status: "FAIL", exitCode: 1, reason: error.message });
    throw error;
  } finally {
    stopWatching();
    log(
      `cleanup begin pid=${runtime?.electronPid ?? launcher.pid ?? "unavailable"} evidence=${fixture.root}`,
    );
    await shutdownOwnedGui(runtime, launcher);
    // 启动器一直存活；正常结束及总时限都能终止完整测试树，不能留下 detached supervisor。
    await stopCommand(launcher);
    log(`cleanup complete evidence=${fixture.root}`);
  }
}
