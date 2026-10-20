import { createHash } from "node:crypto";
import { access, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startCommand, registerTreeKiller, watchBudgetTargets } from "./test-gates-process.mjs";
import {
  repositoryRoot,
  gatesInputsDir,
  gatesToolchainFile,
  bazelOutputBase,
  bazelDiskCache,
} from "./test-gates-bazel-locations.mjs";
import {
  assertBazelReady,
  killByOutputBaseMarker,
  resolveBashSh,
  readElectronRuntimeIdentity,
} from "./test-gates-bazel-runtime.mjs";
import { materializeStageArtifacts } from "./test-gates-action.mjs";
export { assertBazelReady };
import { parseBuildEventFile, actionCacheStates, isBazelCacheMiss } from "./test-gates-bep.mjs";
import { monitorBazelStage } from "./test-gates-bazel-monitor.mjs";

export const bazelTargetName = (id) => `gate-${id.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
export const isBuildStage = (stage) =>
  stage.action === true || stage.kind === "compile" || Boolean(stage.outputs?.length);
export const isUncachedStage = (stage) =>
  Boolean(stage.noCache || stage.packaging || stage.externalMutable);

// Every recipe is native; GUI phases share one native lifecycle target.
export function bazelizeStages(raw) {
  const suites = new Map();
  for (const stage of raw)
    if (stage.fixture) {
      if (!suites.has(stage.suite)) suites.set(stage.suite, []);
      suites.get(stage.suite).push(stage);
    }
  const emitted = new Set();
  const stages = raw.flatMap((stage) => {
    if (!stage.fixture) return [stage];
    if (emitted.has(stage.suite)) return [];
    emitted.add(stage.suite);
    return [
      {
        id: `gui-suite-${stage.suite}`,
        kind: "test",
        realOmp: true,
        parallelGroup: "isolated-runtime",
        lifecycle: suites.get(stage.suite),
        dependsOn: [...new Set(suites.get(stage.suite).flatMap((phase) => phase.dependsOn ?? []))],
        command: "node",
        args: ["scripts/test-gates-gui-suite.mjs", "--suite", stage.suite],
      },
    ];
  });
  const groups = [];
  for (let index = 0; index < stages.length;) {
    const group = stages[index].parallelGroup ?? stages[index].id;
    let end = index + 1;
    while (
      stages[index].parallelGroup &&
      end < stages.length &&
      stages[end].parallelGroup === group
    )
      end++;
    const members = stages.slice(index, end);
    groups.push({
      id: `bazel-${group}`,
      kind: members.every((s) => s.kind === "compile") ? "compile" : "check",
      bazel: {
        group,
        stages: members,
        localTestJobs: members.every((stage) => stage.testFile && stage.realOmp) ? 2 : 4,
      },
    });
    index = end;
  }
  return groups;
}

let inputsWritten = false;
const writtenControls = new Set();
let toolchainIdentity;
let runtimeToolchain = {};
let cachedToolchainValidated = false;
const normalize = (value) =>
  typeof value === "string"
    ? value
        .split(repositoryRoot)
        .join("${WORKSPACE}")
        .split(repositoryRoot.replaceAll("\\", "/"))
        .join("${WORKSPACE}")
    : value;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const semanticKey =
  /^(?:ZCODE_|OMP_|OMPCODE_|PI_|CLAUDE_|CI$|NODE_ENV$|NODE_OPTIONS$|ELECTRON_|PLAYWRIGHT_|VITE_|CSC_|WIN_CSC_|TZ$|LANG$|LC_)/iu;
const needsElectron = (stage) => Boolean(stage.electron || stage.lifecycle || stage.packaging);
async function writeControlFile(stage, context) {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => {
        if (!semanticKey.test(key)) return false;
        if (
          !/^(?:build|bootstrap):/u.test(stage.id) &&
          /^ZCODE_(?:BUILTIN|PERSONAL)_PROVIDER_CONFIG_FILE$/iu.test(key)
        )
          return false;
        if (key === "OMP_RPC_BINARY_PATH") return false; // content identity is in toolchain
        if (
          stage.realOmp &&
          /^(?:OMP_RPC_ARGS_JSON|OMP_E2E_MODEL_SELECTOR|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_FILES|OMP_AUTH_BROKER_.+|CLAUDE_CONFIG_DIR|OMP_OFFLINE|(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL)$/iu.test(
            key,
          )
        )
          return false;
        return true;
      })
      .map(([key, value]) => [key, normalize(value)]),
  );
  const recipe = { ...stage, command: stage.command === process.execPath ? "node" : stage.command };
  delete recipe.parallelGroup;
  if (recipe.lifecycle)
    recipe.lifecycle = recipe.lifecycle.map((phase) => {
      const semantic = { ...phase };
      delete semantic.parallelGroup;
      return semantic;
    });
  if (recipe.semanticHead) recipe.head = context.snapshot?.head ?? context.head;
  const control = { stage: recipe, env };
  control.toolchain = {
    ...(stage.realOmp ? { omp: runtimeToolchain.omp } : {}),
    ...(needsElectron(stage) ? { electron: runtimeToolchain.electron } : {}),
  };
  // External configuration content participates even when its stable pathname does not change.
  const files = {};
  for (const [key, value] of Object.entries({ ...env, ...stage.env })) {
    if (
      typeof value !== "string" ||
      !/(?:FILE|PATH|ROOT)$/iu.test(key) ||
      key === "OMP_RPC_BINARY_PATH"
    )
      continue;
    try {
      files[key] = digest(await readFile(value.replaceAll("${WORKSPACE}", repositoryRoot)));
    } catch (error) {
      if (!["ENOENT", "EISDIR", "EINVAL"].includes(error.code)) throw error;
    }
  }
  control.configurationFiles = files;
  const target = bazelTargetName(stage.id);
  await writeFile(join(gatesInputsDir, `${target}.json`), JSON.stringify(control));
  writtenControls.add(target);
  return target;
}
async function writeToolchainFile(context) {
  if (toolchainIdentity) {
    await writeFile(gatesToolchainFile, toolchainIdentity);
    return;
  }
  const info = {
    node: process.versions.node,
    nodeContent: digest(await readFile(process.execPath)),
    platform: process.platform,
    arch: process.arch,
    pnpm: process.env.npm_config_user_agent?.split(" ")[0],
    lock: digest(await readFile(join(repositoryRoot, "pnpm-lock.yaml"))),
  };
  if (process.env.npm_execpath) info.pnpmContent = digest(await readFile(process.env.npm_execpath));
  const modulesText = await readFile(join(repositoryRoot, "node_modules/.modules.yaml"), "utf8");
  let installed;
  try {
    installed = JSON.parse(modulesText);
  } catch {
    const { parse } = createRequire(join(repositoryRoot, "package.json"))("yaml");
    installed = parse(modulesText);
  }
  delete installed.virtualStoreDir;
  delete installed.storeDir;
  delete installed.prunedAt;
  info.installedGraph = digest(JSON.stringify(installed));
  if (context.omp && context.nativeStages?.some((stage) => stage.realOmp))
    runtimeToolchain.omp = digest(await readFile(context.omp));
  toolchainIdentity = JSON.stringify(info);
  await writeFile(gatesToolchainFile, toolchainIdentity);
}

export async function runBazelStage(stage, context, onFailure) {
  const started = performance.now();
  const originals = stage.bazel.stages;
  const cacheOnly = stage.bazel.cacheOnly === true;
  if (cacheOnly && originals.some(isUncachedStage))
    return { status: "CACHE_MISS", targets: [], reason: "Required uncached stage" };
  const missing = originals.find((s) => s.realOmp && !context.omp);
  if (missing) return { status: "FAIL", reason: `No installed omp for ${missing.id}`, targets: [] };
  if (cacheOnly) {
    // 全新 output_base 的 workspace-status 动作尚无产物，Bazel 会在目标分析前中止，
    // 且不发布目标级失效分类；此时直接沿原分组建立原生缓存，不猜测控制台错误。
    try {
      await access(join(bazelOutputBase, "execroot", "_main", "bazel-out", "stable-status.txt"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { status: "CACHE_MISS", targets: [], reason: "Native cache not initialized" };
    }
  }
  if (cacheOnly && originals.some(needsElectron) && !runtimeToolchain.electron) {
    try {
      runtimeToolchain.electron = await readElectronRuntimeIdentity();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { status: "CACHE_MISS", targets: [], reason: "Electron preparation required" };
    }
  }
  if (originals.some(needsElectron) && !runtimeToolchain.electron)
    throw new Error("Electron runtime consumers require successful electron-runtime-prepare");
  await mkdir(gatesInputsDir, { recursive: true });
  inputsWritten = true;
  await writeFile(
    join(gatesInputsDir, "runtime.json"),
    JSON.stringify({ env: process.env, omp: context.omp, workspace: repositoryRoot }),
  );
  await writeToolchainFile(context);
  // Dependencies can be analyzed before their risk group is invoked. Populate every
  // declared control once up front, while still scheduling only the current group.
  const all = context.nativeStages ?? originals;
  for (const recipe of all)
    if (!writtenControls.has(bazelTargetName(recipe.id))) await writeControlFile(recipe, context);
  const targets = [];
  for (const recipe of originals) {
    const target = bazelTargetName(recipe.id);
    if (!writtenControls.has(target)) await writeControlFile(recipe, context);
    targets.push(target);
  }
  const info = await assertBazelReady();
  const bepPath = join(gatesInputsDir, `bep-${stage.id}.json`);
  const profilePath = join(gatesInputsDir, `profile-${stage.id}.json.gz`);
  const executionPath = join(gatesInputsDir, `execution-${stage.id}.json`);
  await rm(bepPath, { force: true });
  for (const target of targets) await rm(join(gatesInputsDir, `${target}.live`), { force: true });
  const monitor = cacheOnly
    ? undefined
    : monitorBazelStage(targets, bepPath, context.clock, (failure) =>
        onFailure?.({
          ...failure,
          targetId: originals[targets.indexOf(failure.target)]?.id,
        }),
      );
  let code;
  const unregister = registerTreeKiller(() => killByOutputBaseMarker());
  const stopBudgetTargets = watchBudgetTargets(
    targets.map((target) => join(gatesInputsDir, `${target}.live`)),
  );
  try {
    const child = startCommand(
      info.path,
      [
        "--nohome_rc",
        "--nosystem_rc",
        `--output_base=${bazelOutputBase}`,
        originals.every(isBuildStage) ? "build" : "test",
        "--test_summary=short",
        "--test_output=errors",
        "--cache_test_results=auto",
        ...(cacheOnly ? ["--check_tests_up_to_date"] : []),
        "--nokeep_going",
        "--notest_keep_going",
        "--noenable_runfiles",
        "--jobs=4",
        `--local_test_jobs=${stage.bazel.localTestJobs}`,
        `--disk_cache=${bazelDiskCache}`,
        "--build_event_publish_all_actions",
        `--build_event_json_file=${bepPath}`,
        `--profile=${profilePath}`,
        `--execution_log_json_file=${executionPath}`,
        `--define=GATES_NODE=${process.execPath}`,
        `--test_env=JCH_GATES_NODE=${process.execPath}`,
        ...targets.map((target) => `//:${target}`),
      ],
      { stageId: stage.id, env: { BAZEL_SH: await resolveBashSh() } },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (text) => process.stdout.write(text));
    code = await new Promise((done) => {
      child.once("error", () => done(1));
      child.once("close", (exit) => done(exit ?? 1));
    });
  } finally {
    await monitor?.stop();
    unregister();
    stopBudgetTargets();
  }
  if (cacheOnly && (await isBazelCacheMiss(bepPath, code))) {
    console.log("[gate] native cache check requires execution; retaining original risk groups");
    return {
      status: "CACHE_MISS",
      targets: [],
      bepPath,
      seconds: (performance.now() - started) / 1000,
    };
  }
  const events = await parseBuildEventFile(bepPath, targets);
  const cacheStates = await actionCacheStates(executionPath);
  const records = originals.map((original, index) => {
    const event = events.get(targets[index]);
    const complete = event?.complete && event.status;
    const status =
      complete && event.status === "PASSED"
        ? "PASS"
        : monitor?.failure() && !complete
          ? "CANCELLED"
          : "FAIL";
    const cacheState =
      status !== "PASS"
        ? "incomplete"
        : isBuildStage(original)
          ? cacheStates
            ? (cacheStates.get(targets[index]) ?? "localCache")
            : "incomplete"
          : event.cacheState;
    return {
      id: original.id,
      status,
      seconds: event?.seconds ?? 0,
      cached: status === "PASS" && ["localCache", "diskCache"].includes(cacheState),
      cacheState,
      executor: "bazel",
      logPath: event?.logPath,
      ...(status !== "PASS"
        ? {
            reason: complete
              ? `Bazel ${event.status}; log=${event.logPath ?? bepPath}`
              : `Bazel exited ${code} without complete BEP evidence`,
          }
        : {}),
    };
  });
  const passed =
    code === 0 &&
    records.every((record) => record.status === "PASS" && (!cacheOnly || record.cached));
  if (passed)
    for (const recipe of originals.filter(isBuildStage))
      await materializeStageArtifacts(recipe, join(repositoryRoot, "bazel-bin"));
  if (passed && cacheOnly) cachedToolchainValidated = true;
  if (passed && originals.some((recipe) => recipe.id === "electron-runtime-prepare")) {
    // 静态组只需要可读的前序控制文件；准备后才以真实 binary 内容更新消费者，
    // 避免未下载的安装包在准备获得预算监督之前因 ENOENT 提前失败。
    const electron = await readElectronRuntimeIdentity();
    // 必跑准备若改变真实工具链，先前只读缓存证据不再适用，必须失败而非沿用。
    if (
      cachedToolchainValidated &&
      JSON.stringify(electron) !== JSON.stringify(runtimeToolchain.electron)
    )
      throw new Error("Electron runtime changed after native cache validation");
    runtimeToolchain.electron = electron;
    for (const recipe of all.filter(needsElectron)) await writeControlFile(recipe, context);
  }
  for (const record of records)
    console.log(
      `[${record.status}] ${record.id} ${record.seconds.toFixed(1)}s (bazel ${record.cacheState})${record.reason ? `: ${record.reason}` : ""}`,
    );
  return {
    status: passed ? "PASS" : "FAIL",
    seconds: (performance.now() - started) / 1000,
    targets: records,
    slowTargets: [...records].sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    bepPath,
    profilePath,
    executionPath,
  };
}
export async function cleanupBazelInputs() {
  if (!inputsWritten) return;
  // Preserve official BEP/profile/execution evidence; remove runtime credentials
  // and recipes only. Source globs exclude this entire transport directory.
  for (const target of writtenControls) {
    await rm(join(gatesInputsDir, `${target}.json`), { force: true });
    await rm(join(gatesInputsDir, `${target}.live`), { force: true });
  }
  await rm(join(gatesInputsDir, "runtime.json"), { force: true });
  await rm(gatesToolchainFile, { force: true });
}
