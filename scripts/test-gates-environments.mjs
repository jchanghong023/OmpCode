import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { commandOutput, inside, sameSnapshot, exists } from "./test-gates-process.mjs";

const missing = (reason) => ({ status: "UNVERIFIED_MISSING_ENV", reason });

export async function environmentConfig() {
  const path = process.env.ZCODE_GATE_ENVIRONMENTS;
  return path ? JSON.parse(await readFile(path, "utf8")) : { stages: {} };
}

// 配置例：stages[阶段ID] = { prepare:{command,args}, environmentFile, cleanup:{command,args} }。
// prepare 是用户提供的隔离 fixture 生命周期适配器，不是检查或另一技能。
// environmentFile = { snapshot:{head,contentHash}, isolatedRoot, env:{...} }。
export async function fixtureStage(stage, context) {
  const setup = context.environments.stages?.[stage.id];
  if (!setup)
    return missing(
      `Configure ZCODE_GATE_ENVIRONMENTS stage ${stage.id}; no daily instance is used`,
    );
  if (setup.prepare && !setup.cleanup)
    return missing("A fixture preparation command must have an owned-process cleanup command");
  async function executeFixture() {
    if (setup.prepare) {
      const result = await commandOutput(setup.prepare.command, setup.prepare.args ?? [], {
        env: setup.prepare.env,
      });
      if (result.code) return { status: "FAIL", reason: "Fixture preparation failed" };
    }
    if (!setup.environmentFile) return missing("Fixture must provide environmentFile");
    const fixture = JSON.parse(await readFile(setup.environmentFile, "utf8"));
    if (!sameSnapshot(context.snapshot, fixture.snapshot))
      return missing("Fixture build/source snapshot differs from this gate");
    if (stage.realOmp && fixture.ompBinary !== context.omp)
      return missing("Fixture Host must use the installed omp binary recorded by this run");
    const root = fixture.isolatedRoot;
    if (!root || !isAbsolute(root) || root === process.cwd() || root === homedir())
      return missing("Fixture needs a separate absolute isolatedRoot");
    const env = { ...fixture.env, ...stage.env };
    if (stage.phase === "before" || stage.phase === "after")
      env.OMP_E2E_PROFILE_PHASE = stage.phase;
    else if (stage.phase) env.OMP_E2E_PHASE = stage.phase;
    if (stage.realOmp) {
      env.OMP_RPC_BINARY_PATH = context.omp;
      env.OMP_NATIVE_E2E_BINARY = context.omp;
      env.OMP_E2E_OMP_BINARY = context.omp;
      env.OMP_NATIVE_E2E = "1";
    }
    for (const key of [
      "ZCODE_DATA_BASE_DIR",
      "ZCODE_DESKTOP_USER_DATA_DIR",
      "OMP_E2E_WORKSPACE",
      "OMP_CONFIG_ROOT",
    ]) {
      if (env[key] && !inside(root, env[key])) return missing(`${key} is outside the fixture root`);
    }
    const runtimePath = env.OMP_E2E_RUNTIME_MANIFEST ?? env.OMP_NATIVE_GUI_META;
    if (runtimePath) {
      if (!inside(root, runtimePath)) return missing("Runtime metadata is outside fixture root");
      const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
      if (!inside(root, runtime.runRoot ?? runtime.root ?? ""))
        return missing("Runtime data root is not isolated");
      const endpoint = new URL(runtime.endpoint ?? runtime.cdpUrl);
      if (
        !["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
        ["9229", "9230"].includes(endpoint.port)
      )
        return missing("Runtime must use a dedicated local CDP endpoint");
      const pid = runtime.electronPid ?? runtime.pid;
      const key = stage.file ?? stage.id;
      const previous = context.guiProcesses.get(key);
      if (["cold", "after", "recovery"].includes(stage.phase) && previous && previous.pid === pid)
        return missing("Cold/recovery phase requires a restarted fixture process");
      if (previous && ["cold", "after"].includes(stage.phase) && previous.root !== root)
        return missing("Cold/recovery phase must reuse its live data root");
      context.guiProcesses.set(key, { pid, root });
    } else if (!fixture.dedicatedEndpoint) {
      return missing(
        "Legacy GUI fixture must explicitly own its endpoint and supply dedicatedEndpoint",
      );
    }
    const result = await commandOutput(stage.command, stage.args, { env });
    return {
      status: result.code ? "FAIL" : result.skipped ? "UNVERIFIED_MISSING_ENV" : "PASS",
      exitCode: result.code,
      ...(result.skipped ? { reason: "Existing check reported skipped/unverified coverage" } : {}),
    };
  }
  let outcome;
  try {
    outcome = await executeFixture();
  } catch (error) {
    outcome = { status: "FAIL", reason: error.message };
  }
  if (setup.cleanup) {
    const result = await commandOutput(setup.cleanup.command, setup.cleanup.args ?? [], {
      env: setup.cleanup.env,
    });
    if (result.code)
      outcome = {
        status: "FAIL",
        reason: `Fixture cleanup failed; owned processes may remain (check status: ${outcome.status})`,
      };
  }
  return outcome;
}

export async function wslStage(context) {
  if (process.platform !== "win32")
    return missing("Configure a Windows-side second-platform runner; current OS is already Linux");
  const target = context.environments.wsl;
  if (
    !target?.distribution ||
    !target.checkout?.startsWith("/") ||
    target.checkout.startsWith("/mnt/")
  )
    return missing(
      "Specify wsl.distribution and a separate Linux-native wsl.checkout; do not share Windows caches",
    );
  const result = await commandOutput("wsl.exe", [
    "--distribution",
    target.distribution,
    "--cd",
    target.checkout,
    "--exec",
    "env",
    `ZCODE_GATE_ENVIRONMENTS=${target.environmentConfig ?? ""}`,
    `ZCODE_GATE_PERF_BASELINE=${target.performanceBaseline ?? ""}`,
    "node",
    "scripts/mise-run.mjs",
    "pnpm",
    "fulltest",
    "--human-authorized",
    "--expected-head",
    context.snapshot.head,
    "--expected-content",
    context.snapshot.contentHash,
    "--expected-platform",
    "linux",
    "--expected-distro",
    "centos7",
  ]);
  return {
    status: result.code ? "FAIL" : result.skipped ? "UNVERIFIED_MISSING_ENV" : "PASS",
    exitCode: result.code,
  };
}

export async function regularStage(stage, context) {
  if (stage.realOmp && !context.omp)
    return missing("No installed omp; real validation is not run and omp is not downloaded");
  if (stage.fixture) return await fixtureStage(stage, context);
  if (
    stage.electron &&
    !(await exists(
      join(
        "packages/desktop/node_modules/electron/dist",
        process.platform === "win32" ? "electron.exe" : "electron",
      ),
    ))
  )
    return missing("Workspace Electron runtime is absent");
  const args = [...stage.args];
  if (stage.baseline) {
    if (!process.env.ZCODE_GATE_PERF_BASELINE)
      return missing("Set ZCODE_GATE_PERF_BASELINE to the intended comparison commit");
    args.push(process.env.ZCODE_GATE_PERF_BASELINE);
  }
  if (stage.packageInputs) {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    const desktop = "packages/desktop/dist/linux-unpacked";
    const native = "packages/desktop/dist/centos7-native";
    if (!(await exists(desktop)) || !(await exists(native)))
      return missing("CentOS glibc-2.17 desktop/native build inputs are absent");
    args.push(desktop, native, manifest.version, "packages/desktop/dist");
  }
  const env = { ...stage.env };
  if (stage.realOmp)
    Object.assign(env, {
      OMP_RPC_BINARY_PATH: context.omp,
      OMP_NATIVE_E2E_BINARY: context.omp,
      OMP_AGENT_SKIP_REAL_E2E: "0",
    });
  const result = await commandOutput(stage.command, args, { env });
  return {
    status: result.code ? "FAIL" : result.skipped ? "UNVERIFIED_MISSING_ENV" : "PASS",
    exitCode: result.code,
    ...(result.skipped
      ? { reason: "Existing test reported skips; applicable coverage is not fully verified" }
      : {}),
  };
}
