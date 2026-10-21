import { access, readFile, writeFile, mkdir, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startCommand, watchBudgetTargets } from "./test-gates-process.mjs";
import {
  repositoryRoot,
  gatesInputsDir,
  gatesToolchainFile,
  bazelOutputBase,
  bazelDiskCache,
} from "./test-gates-bazel-locations.mjs";
import {
  assertBazelReady,
  resolveBashSh,
  readElectronRuntimeIdentity,
} from "./test-gates-bazel-runtime.mjs";
import { materializeStageGroup } from "./test-gates-action.mjs";
export { assertBazelReady };
import { parseBuildEventFile, actionCacheStates, isBazelCacheMiss } from "./test-gates-bep.mjs";
import { monitorBazelStage } from "./test-gates-bazel-monitor.mjs";
import { recordInvalidationEvidence } from "./test-gates-invalidation.mjs";
import { buildStageControl, digest, needsElectron } from "./test-gates-bazel-controls.mjs";

export const bazelTargetName = (id) => `gate-${id.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
export const isBuildStage = (stage) =>
  stage.action === true || stage.kind === "compile" || Boolean(stage.outputs?.length);
export const isUncachedStage = (stage) =>
  Boolean(stage.noCache || stage.packaging || stage.externalMutable);

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
const graphTransportOutput = "gates/inputs/generated-build.bazel";
let graphTransportOwned = false;
let toolchainIdentity;
let runtimeToolchain = {};
let cachedToolchainValidated = false;
async function writeControlFile(stage, context) {
  const control = await buildStageControl(stage, context, runtimeToolchain);
  const target = bazelTargetName(stage.id);
  // 写入可能先截断再失败；准入时登记所有权，退出仍须清空本轮已触碰的配方。
  writtenControls.add(target);
  await writeFile(join(gatesInputsDir, `${target}.json`), JSON.stringify(control));
  return target;
}
async function writeToolchainFile(context, consumers) {
  // 图生成先初始化基础身份；真实核消费者准入时仍须补全内容身份，不能沿用空身份控制。
  if (context.omp && !runtimeToolchain.omp && consumers.some((stage) => stage.realOmp)) {
    runtimeToolchain.omp = digest(await readFile(context.omp));
    for (const recipe of consumers.filter((stage) => stage.realOmp))
      if (writtenControls.has(bazelTargetName(recipe.id))) await writeControlFile(recipe, context);
  }
  if (toolchainIdentity) return writeFile(gatesToolchainFile, toolchainIdentity);
  const info = {
    // 工具路径只用于执行；本轮真实 launcher/已安装 native 内容才进入动作身份。
    bazel: (await assertBazelReady()).identity,
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
  toolchainIdentity = JSON.stringify(info);
  await writeFile(gatesToolchainFile, toolchainIdentity);
}
export async function runBazelStage(stage, context, onFailure) {
  const started = performance.now();
  const originals = stage.bazel.stages;
  const cacheOnly = stage.bazel.cacheOnly === true;
  const analysisOnly = stage.bazel.analysisOnly === true;
  const all = context.nativeStages ?? originals;
  if (cacheOnly && originals.some(isUncachedStage))
    return { status: "CACHE_MISS", targets: [], reason: "Required uncached stage" };
  const missing = !analysisOnly && originals.find((s) => s.realOmp && !context.omp);
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
    // 静态组已提前写过配方；查询前补全 Electron 身份，否则旧空身份必然导致 GUI 缓存 miss。
    for (const recipe of (context.nativeStages ?? originals).filter(needsElectron))
      if (writtenControls.has(bazelTargetName(recipe.id))) await writeControlFile(recipe, context);
  }
  const targets = originals.map((recipe) => bazelTargetName(recipe.id));
  if (!analysisOnly) {
    if (originals.some(needsElectron) && !runtimeToolchain.electron)
      throw new Error("Electron runtime consumers require successful electron-runtime-prepare");
    await mkdir(gatesInputsDir, { recursive: true });
    inputsWritten = true;
    // 查询不接管旧产物；普通生成准入后由既有 stopAll 清理链收回传输所有权。
    if (
      !cacheOnly &&
      originals.some(
        (recipe) => recipe.id === "bazel-graph" && recipe.outputs?.includes(graphTransportOutput),
      )
    )
      graphTransportOwned = true;
    await writeFile(
      join(gatesInputsDir, "runtime.json"),
      JSON.stringify({ env: process.env, omp: context.omp, workspace: repositoryRoot }),
    );
    await writeToolchainFile(context, all);
    // 依赖可在所属风险组之前分析，提前填充完整计划的控制输入。
    for (const recipe of all)
      if (!writtenControls.has(bazelTargetName(recipe.id))) await writeControlFile(recipe, context);
    for (const target of targets) await writeFile(join(gatesInputsDir, `${target}.live`), "");
  }
  const info = await assertBazelReady();
  const paths = context.diagnostics?.createInvocationPaths(stage.id);
  const bepPath = paths?.bep ?? join(gatesInputsDir, `bep-${stage.id}.json`);
  const profilePath = paths?.profile ?? join(gatesInputsDir, `profile-${stage.id}.json.gz`);
  const executionPath = paths?.jsonexecution ?? join(gatesInputsDir, `execution-${stage.id}.json`);
  await rm(bepPath, { force: true });
  const monitor =
    cacheOnly || analysisOnly
      ? undefined
      : monitorBazelStage(targets, bepPath, context.clock, (failure) =>
          onFailure?.({
            ...failure,
            targetId: originals[targets.indexOf(failure.target)]?.id,
          }),
        );
  let code, invocation, commandArgs;
  const stopBudgetTargets = analysisOnly
    ? () => {}
    : watchBudgetTargets(targets.map((target) => join(gatesInputsDir, `${target}.live`)));
  try {
    commandArgs = [
      "--nohome_rc",
      "--nosystem_rc",
      `--output_base=${bazelOutputBase}`,
      analysisOnly || originals.every(isBuildStage) ? "build" : "test",
      "--announce_rc",
      ...(context.cacheDebug ? ["--config=cache-debug"] : []),
      "--test_summary=short",
      "--test_output=errors",
      "--cache_test_results=auto",
      ...(analysisOnly ? ["--nobuild"] : cacheOnly ? ["--check_tests_up_to_date"] : []),
      cacheOnly || analysisOnly ? "--keep_going" : "--nokeep_going",
      "--notest_keep_going",
      "--noenable_runfiles",
      "--jobs=4",
      `--local_test_jobs=${stage.bazel.localTestJobs}`,
      `--disk_cache=${bazelDiskCache}`,
      "--build_event_publish_all_actions",
      `--build_event_json_file=${bepPath}`,
      `--profile=${profilePath}`,
      `--execution_log_json_file=${executionPath}`,
      ...(paths ? [`--explain=${paths.explain}`, "--verbose_explanations"] : []),
      `--define=GATES_NODE=${process.execPath}`,
      `--test_env=JCH_GATES_NODE=${process.execPath}`,
      ...targets.map((target) => `//:${target}`),
    ];
    const env = { BAZEL_SH: await resolveBashSh() };
    invocation = await context.diagnostics?.beginInvocation({
      id: stage.id,
      command: info.path,
      args: commandArgs,
      env,
      paths,
    });
    const child = startCommand(info.path, commandArgs, { stageId: stage.id, env, bazel: true });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (text) => process.stdout.write(text));
    code = await new Promise((done) => {
      child.once("error", () => done(1));
      child.once("close", (exit) => done(exit ?? 1));
    });
  } finally {
    await monitor?.stop();
    stopBudgetTargets();
    const diagnosticStarted = performance.now();
    await invocation?.finish({ exitCode: code });
    context.diagnostics?.recordPhase(stage.id, "nativeEvidence", diagnosticStarted);
  }
  if (analysisOnly)
    return {
      status: code === 0 ? "ANALYZED" : "FAIL",
      targets: [],
      generatedGraphVerified: false,
      seconds: (performance.now() - started) / 1000,
      bepPath,
      profilePath,
    };
  if (paths) {
    const invalidationStarted = performance.now();
    await recordInvalidationEvidence({
      snapshot: context.snapshot,
      evidenceDir: `${paths.evidence}.details`,
      invocation: {
        id: stage.id,
        bepPath,
        executionPath,
        explainPath: paths.explain,
        cli: commandArgs,
        forcedExternalTargets: originals.filter(isUncachedStage).map((s) => bazelTargetName(s.id)),
      },
    });
    context.diagnostics?.recordPhase(stage.id, "invalidationEvidence", invalidationStarted);
  }
  const cacheMiss = cacheOnly && (await isBazelCacheMiss(bepPath, code));
  if (cacheMiss)
    console.log("[gate] native cache is out of date; build/test execution remains prohibited");
  const events = await parseBuildEventFile(bepPath, targets, { checkTestsUpToDate: cacheOnly });
  const cacheStates = await actionCacheStates(executionPath);
  const records = originals.map((original, index) => {
    const event = events.get(targets[index]);
    const complete = event?.complete && event.status;
    // 原因：过期检查曾丢弃全部目标明细；依据原生分类区分过期与未检查，不当作测试失败。
    const outOfDate =
      cacheOnly && event?.failureDetail?.execution?.code === "ACTION_NOT_UP_TO_DATE";
    const status = outOfDate
      ? "OUT_OF_DATE"
      : complete && event.status === "PASSED"
        ? "PASS"
        : cacheMiss
          ? "NOT_CHECKED"
          : monitor?.failure() && !complete
            ? "CANCELLED"
            : "FAIL";
    const cacheState = outOfDate
      ? "outOfDate"
      : status !== "PASS"
        ? "incomplete"
        : cacheOnly
          ? "upToDate"
          : isBuildStage(original)
            ? (cacheStates?.get(targets[index]) ?? "unknown")
            : event.cacheState;
    return {
      id: original.id,
      status,
      seconds: event?.seconds ?? 0,
      cached:
        status === "PASS" &&
        ["localCache", "diskCache", "remoteCache", "unknownCache", "upToDate"].includes(cacheState),
      cacheState,
      executor: "bazel",
      logPath: event?.logPath,
      evidenceSource: cacheOnly
        ? `${bepPath} (--check_tests_up_to_date)`
        : isBuildStage(original)
          ? cacheStates?.has(targets[index])
            ? executionPath
            : `${bepPath} (completion only; cache provenance unobserved)`
          : bepPath,
      ...(event?.failureDetail ? { failureDetail: event.failureDetail } : {}),
      ...(event?.previousRunSeconds !== undefined
        ? { previousRunSeconds: event.previousRunSeconds }
        : {}),
      ...(status !== "PASS"
        ? {
            reason:
              event?.failureDetail?.message ??
              (status === "NOT_CHECKED"
                ? "Not checked: an outdated dependency or incomplete native evidence blocks this target"
                : complete
                  ? `Bazel ${event.status}; log=${event.logPath ?? bepPath}`
                  : `Bazel exited ${code} without complete BEP evidence`),
          }
        : {}),
    };
  });
  const passed =
    code === 0 &&
    records.every((record) => record.status === "PASS" && (!cacheOnly || record.cached));
  // 查询不能恢复声明产物；仅真实完整执行通过后物化，避免暖路径重复复制。
  if (passed && !cacheOnly) {
    const materializing = performance.now();
    const products = originals.filter((recipe) => recipe.outputs?.length);
    await materializeStageGroup(products, join(repositoryRoot, "bazel-bin"), {
      clock: context.clock,
    });
    context.diagnostics?.recordPhase(stage.id, "materialization", materializing);
    console.log(
      `[gate] materialization stages=${products.length} seconds=${((performance.now() - materializing) / 1000).toFixed(3)}`,
    );
  }
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
      `[${record.status}] ${record.id} ${record.seconds.toFixed(1)}s (bazel ${record.cacheState}; source=${record.evidenceSource}; log=${record.logPath ?? "unobserved"})${record.previousRunSeconds !== undefined ? ` previous-run=${record.previousRunSeconds.toFixed(1)}s` : ""}${record.reason ? `: ${record.reason}` : ""}`,
    );
  return {
    status: passed ? "PASS" : cacheMiss ? "CACHE_MISS" : "FAIL",
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
  // 删除/新建会使 Windows 根 glob 每组失效；敏感传输仅截断为稳定的零字节占位。
  // 非敏感工具链声明保留；每次入口仍实际重算身份、配方与环境，不能复用占位作成功证据。
  let firstError;
  const paths = [
    ...[...writtenControls].flatMap((target) => [
      join(gatesInputsDir, `${target}.json`),
      join(gatesInputsDir, `${target}.live`),
    ]),
    join(gatesInputsDir, "runtime.json"),
    ...(graphTransportOwned ? [join(repositoryRoot, graphTransportOutput)] : []),
  ];
  for (const path of paths) {
    try {
      // truncate 不创建未知文件；尚未准入 .live 或部分写入失败留下的 ENOENT 可忽略。
      await truncate(path, 0);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      // 一个权限/IO 错误不能阻止其他敏感输入清空，也不能替换最先出现的异常。
      if (!firstError) firstError = error;
      else console.error("[gate] Additional Bazel input cleanup failure:", error);
    }
  }
  if (firstError) throw firstError;
}
