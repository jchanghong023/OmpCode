#!/usr/bin/env node
/* eslint-disable max-lines -- Windows E2E 父 runner 需要集中维护构建、分片、取消和 summary 完整性门禁。 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnCancellableStep, startStepExecution } from "./e2e-step-process.mjs";
import { loadE2ELocalEnv } from "./e2e-local-env.mjs";
import {
  FORK_DEFERRED_E2E_SPECS,
  hasRequiredSshE2EEnvironment,
  isSshFormalSpec,
  isTemporarilyExcludedFormalSpec,
} from "./e2e-formal-spec-selection.mjs";

const RUNNER_SHARD_ARG_PREFIX = "--shards=";
const DEFAULT_SPEC_DURATION_PROFILE_PATH = "test/e2e/spec-duration-weights.json";

function readPositiveInteger(value, source) {
  if (!/^\d+$/u.test(value ?? "") || Number(value) <= 0) {
    throw new Error(`${source} must be a positive integer, received: ${value || "<empty>"}`);
  }
  return Number(value);
}

function splitRunnerArgs(args) {
  const shardArgs = args.filter((arg) => arg.startsWith(RUNNER_SHARD_ARG_PREFIX));
  if (shardArgs.length > 1) {
    throw new Error("--shards may only be specified once");
  }

  const explicitShardTotal = shardArgs[0]
    ? readPositiveInteger(shardArgs[0].slice(RUNNER_SHARD_ARG_PREFIX.length), "--shards")
    : undefined;
  return {
    explicitShardTotal,
    wdioArgs: args.filter((arg) => !arg.startsWith(RUNNER_SHARD_ARG_PREFIX)),
  };
}

function isTargetedRun(args, env) {
  const requestedSpec = env.ZCODE_E2E_SPEC?.trim();
  return (
    Boolean(requestedSpec) ||
    args.some(
      (arg, index) =>
        arg === "--spec" ||
        arg.startsWith("--spec=") ||
        (index > 0 && args[index - 1] === "--spec"),
    )
  );
}

function isManualReviewRun(args, env) {
  return (
    env.ZCODE_E2E_MANUAL_REVIEW?.trim() === "1" ||
    args.concat(env.ZCODE_E2E_SPEC ?? "").some((arg) => arg.includes("/manual-review/"))
  );
}

export function resolveWindowsE2EShardTotal({
  args,
  env,
  platform,
  logicalCpuCount = cpus().length,
  totalMemoryBytes = totalmem(),
}) {
  const { explicitShardTotal } = splitRunnerArgs(args);
  const hasNativeShard = args.some((arg) => arg === "--shard" || arg.startsWith("--shard="));
  const isCaptureRun = env.E2E_PROVIDER_HTTP_MODE?.trim() === "capture";
  // 修复原因：性能入口固定携带 --shards=10；若显式分片先返回，定向、人工复核、
  // capture 或上层 native shard 会被重复启动。特殊模式必须先锁定单 child。
  if (hasNativeShard || isTargetedRun(args, env) || isManualReviewRun(args, env) || isCaptureRun) {
    return 1;
  }

  if (explicitShardTotal !== undefined) {
    return explicitShardTotal;
  }

  const envShardTotal = env.ZCODE_E2E_SHARD_TOTAL?.trim();
  if (envShardTotal) {
    return readPositiveInteger(envShardTotal, "ZCODE_E2E_SHARD_TOTAL");
  }

  // 修复原因：按机器资源自动启用多 shard 会让无参数命令产生隐式并发，既不便于
  // 本地复现，也会放大 session/清理竞争；默认固定单 shard，并行必须由调用方显式选择。
  void platform;
  void logicalCpuCount;
  void totalMemoryBytes;
  return 1;
}

export function listDefaultFormalE2ESpecs(desktopDir, env = process.env) {
  const e2eDir = join(desktopDir, "test/e2e");
  const specs = [];
  const includeSshSpecs = hasRequiredSshE2EEnvironment(env);
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "manual-review") continue;
        visit(join(directory, entry.name), relativePath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        relativePath !== "upstream-provider.test.ts" &&
        !isTemporarilyExcludedFormalSpec(`./test/e2e/${relativePath}`) &&
        !FORK_DEFERRED_E2E_SPECS.includes(`./test/e2e/${relativePath}`) &&
        (includeSshSpecs || !isSshFormalSpec(`./test/e2e/${relativePath}`))
      ) {
        specs.push(`./test/e2e/${relativePath}`);
      }
    }
  };
  visit(e2eDir);
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    specs.push(
      "./test/e2e/omp-app-server.e2e.ts",
      "./test/e2e/omp-subagents.e2e.ts",
      "./test/e2e/omp-workflows.e2e.ts",
    );
  }
  return specs;
}

export function partitionE2ESpecsByWeight(specs, shardTotal, profile) {
  const defaultWeightMs = readPositiveInteger(
    String(profile.defaultWeightMs),
    "spec duration defaultWeightMs",
  );
  const buckets = Array.from({ length: shardTotal }, () => ({
    estimatedWeightMs: 0,
    specs: [],
  }));
  const weightedSpecs = specs
    .map((spec) => ({
      spec,
      weightMs: Number(profile.weights?.[spec]) || defaultWeightMs,
    }))
    .sort((left, right) => right.weightMs - left.weightMs || left.spec.localeCompare(right.spec));

  for (const weightedSpec of weightedSpecs) {
    let targetIndex = 0;
    for (let index = 1; index < buckets.length; index += 1) {
      if (buckets[index].estimatedWeightMs < buckets[targetIndex].estimatedWeightMs) {
        targetIndex = index;
      }
    }
    buckets[targetIndex].specs.push(weightedSpec.spec);
    buckets[targetIndex].estimatedWeightMs += weightedSpec.weightMs;
  }

  // 修复原因：历史权重只决定 shard 归属；每个 shard 内恢复稳定路径顺序，
  // 避免权重更新改变 fixture/mock 的执行顺序并制造无意义的快照差异。
  for (const bucket of buckets) bucket.specs.sort((a, b) => a.localeCompare(b));
  return buckets;
}

function formatRunId(date = new Date()) {
  return `desktop-e2e-${date.toISOString().replace(/[-:.TZ]/gu, "")}`;
}

export function createWindowsE2ERunId({ timestamp, processId, entropy }) {
  return `${formatRunId(timestamp)}-p${processId}-${entropy}`;
}

function createBuildEnv(env) {
  const { NODE_OPTIONS: _nodeOptions, ...buildEnv } = env;
  return {
    ...buildEnv,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    // Windows full E2E 反复执行时复用 Turbo 内容缓存；冷缓存仍按依赖图构建，
    // targeted/non-Windows 路径不会经过父 runner 的 sharded build env。
    ZCODE_DESKTOP_AGENT_BUILD_MODE: env.ZCODE_DESKTOP_AGENT_BUILD_MODE ?? "turbo",
  };
}

export function createWindowsE2EShardPlan({
  args,
  desktopDir,
  env,
  platform,
  processId = process.pid,
  repoRoot,
  runIdEntropy,
  runIdTimestamp = new Date(),
  weightedSpecBuckets,
}) {
  const { wdioArgs } = splitRunnerArgs(args);
  const shardTotal = resolveWindowsE2EShardTotal({ args, env, platform });
  // 修复原因：只有 ISO 毫秒的自动 ID 会让同毫秒启动的 runner 共享 HOME/artifact/network。
  // 显式 ID 保持原语义；自动 ID 同时加入 PID 和随机熵，测试可注入固定值稳定验证。
  const runId =
    env.ZCODE_E2E_RUN_ID?.trim() ||
    createWindowsE2ERunId({
      entropy: runIdEntropy ?? randomBytes(8).toString("hex"),
      processId,
      timestamp: runIdTimestamp,
    });
  const artifactRoot = resolve(
    env.ZCODE_E2E_ARTIFACT_DIR?.trim() || join(desktopDir, ".e2e-artifacts", runId),
  );
  const explicitHomeRoot = env.ZCODE_E2E_HOME_DIR?.trim();
  // 修复原因：单 shard runner 也可能并发启动；默认 HOME 若固定为 `.e2e-home`，
  // 不同 runId 会互相清理进程和状态。显式 HOME 保持调用方语义，默认 HOME 才追加 runId。
  const homeRoot = resolve(explicitHomeRoot || join(desktopDir, `.e2e-home-${runId}`));
  const sharded = shardTotal > 1;
  const useWeightedSpecBuckets =
    sharded &&
    weightedSpecBuckets?.length === shardTotal &&
    weightedSpecBuckets.every((bucket) => bucket.specs.length > 0) &&
    !wdioArgs.some((arg) => arg === "--exclude" || arg.startsWith("--exclude="));
  const buildEnv = createBuildEnv(env);

  const buildSteps = sharded
    ? [
        {
          id: "build-desktop",
          kind: "build",
          command: process.execPath,
          args: [join(desktopDir, "scripts/ensure-e2e-desktop-build.mjs")],
          cwd: repoRoot,
          env: buildEnv,
        },
        ...(env.ZCODE_AGENT_SERVER_COMMAND?.trim()
          ? []
          : [
              {
                id: "build-agent",
                kind: "build",
                command: process.execPath,
                args: [join(repoRoot, "scripts/build-desktop-agent-cli.mjs")],
                cwd: repoRoot,
                env: buildEnv,
              },
            ]),
      ]
    : [];

  const children = Array.from({ length: shardTotal }, (_, offset) => {
    const shardIndex = offset + 1;
    const shardId = `${shardIndex}/${shardTotal}`;
    const shardName = `shard-${shardIndex}-of-${shardTotal}`;
    const childRunId = sharded ? `${runId}-${shardName}` : runId;
    const artifactDir = sharded ? join(artifactRoot, shardName) : artifactRoot;
    // 修复原因：默认并发度从多 shard 收敛为单 child 后，旧逻辑会让并发 runner
    // 重新共享 .e2e-home 并互相清理进程；自动 HOME 必须始终携带 runId。
    // 显式单 child HOME 保持原路径兼容，只有显式多 shard 才继续追加 run/shard 身份。
    const childHomeDir = explicitHomeRoot
      ? sharded
        ? join(homeRoot, runId, shardName)
        : homeRoot
      : sharded
        ? join(desktopDir, `.e2e-home-${runId}-shard-${shardIndex}`)
        : join(desktopDir, `.e2e-home-${runId}`);
    const childEnv = {
      ...env,
      ZCODE_E2E_HOME_DIR: childHomeDir,
      ZCODE_E2E_RUN_ID: childRunId,
      ZCODE_E2E_ARTIFACT_DIR: artifactDir,
      ZCODE_E2E_NETWORK_CAPTURE_DIR: sharded
        ? join(artifactDir, "network-capture")
        : resolve(
            env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() || join(artifactDir, "network-capture"),
          ),
      ...(sharded
        ? {
            ZCODE_E2E_SKIP_BUILD: "1",
            ZCODE_E2E_SKIP_AGENT_BUILD: "1",
          }
        : {}),
      ...(useWeightedSpecBuckets
        ? { ZCODE_E2E_SPEC: weightedSpecBuckets[offset].specs.join(",") }
        : {}),
    };

    return {
      id: shardName,
      kind: "child",
      shardId,
      shardIndex,
      shardTotal,
      command: "pnpm",
      args: [
        "exec",
        "wdio",
        "run",
        "wdio.conf.ts",
        ...wdioArgs,
        ...(sharded && !useWeightedSpecBuckets ? [`--shard=${shardId}`] : []),
      ],
      cwd: desktopDir,
      env: childEnv,
      artifactDir,
      summaryPath: join(artifactDir, "summary.json"),
      ...(useWeightedSpecBuckets
        ? {
            specs: weightedSpecBuckets[offset].specs,
            estimatedWeightMs: weightedSpecBuckets[offset].estimatedWeightMs,
          }
        : {}),
    };
  });

  return {
    runId,
    shardTotal,
    wdioArgs,
    artifactRoot,
    distributionKind: useWeightedSpecBuckets ? "historical-lpt" : "wdio-native",
    manifestPath: join(artifactRoot, "shard-manifest.json"),
    buildSteps,
    children,
  };
}

async function writeShardManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function printShardManifest(manifest) {
  console.log(`[e2e-shards] ${JSON.stringify(manifest, null, 2)}`);
}

export class WindowsE2EShardRunError extends Error {
  constructor(message, manifest) {
    super(message);
    this.name = "WindowsE2EShardRunError";
    this.manifest = manifest;
  }
}

export async function executeWindowsE2EShardPlan(
  plan,
  {
    now = Date.now,
    signalSource = process,
    spawnStep: runStep = spawnCancellableStep,
    summaryExists = existsSync,
    writeManifest = writeShardManifest,
    printManifest = printShardManifest,
  } = {},
) {
  const startedAtMs = now();
  const activeExecutions = new Set();
  const terminationRequestedExecutions = new WeakSet();
  const cleanupBarriers = [];
  const cleanupErrors = [];
  const failurePrefix = `ZCODE_E2E_FAILURE_${randomBytes(16).toString("hex")}:`;
  let interruptedBySignal;
  let firstFailure;

  const terminateActiveExecutions = () => {
    for (const execution of activeExecutions) {
      if (
        terminationRequestedExecutions.has(execution) ||
        typeof execution.terminate !== "function"
      ) {
        continue;
      }
      terminationRequestedExecutions.add(execution);
      try {
        cleanupBarriers.push(
          Promise.resolve(execution.terminate()).catch((error) => {
            cleanupErrors.push(error instanceof Error ? error.message : String(error));
          }),
        );
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const recordFailure = (step, payload) => {
    if (firstFailure) return;
    firstFailure = {
      stepId: step.id,
      ...(step.shardId ? { shardId: step.shardId } : {}),
      ...payload,
    };
    console.error(`[e2e-shards] ${payload.title}: ${payload.error}`);
    // 发出失败通知的 worker 也必须终止，不能等待它的截图、after hook 或报告。
    terminateActiveExecutions();
  };

  const runTrackedStep = async (step) => {
    if (firstFailure || interruptedBySignal) {
      return { exitCode: 1, cancelled: true, error: "cancelled before start" };
    }
    let reportedFailure;
    const execution = startStepExecution(runStep, {
      ...step,
      env: { ...step.env, ZCODE_E2E_FAIL_FAST_PREFIX: failurePrefix },
      onFailure: (payload) => {
        reportedFailure ??= payload;
        recordFailure(step, payload);
      },
    });
    activeExecutions.add(execution);
    // 自定义启动器可能在返回 execution 前同步通知失败。
    if (firstFailure || interruptedBySignal) terminateActiveExecutions();
    try {
      let result = await execution.result;
      const cancelled = terminationRequestedExecutions.has(execution);
      if (reportedFailure) {
        result = { ...result, exitCode: result.exitCode || 1, error: reportedFailure.error };
      } else if (!firstFailure && !interruptedBySignal) {
        if (result.error || result.signal || result.exitCode !== 0) {
          recordFailure(step, {
            kind: step.kind === "build" ? "prepare" : "runner",
            title: step.shardId ? `shard ${step.shardId}` : step.id,
            error: result.error
              ? `failed to start: ${result.error}`
              : result.signal
                ? `terminated by signal ${result.signal}`
                : `exited with code ${result.exitCode}`,
          });
        } else if (step.kind === "child" && !summaryExists(step.summaryPath)) {
          // 零退出但没有 summary 不是成功；立即取消尚在运行的分片。
          result = { exitCode: 1, error: `missing shard summary: ${step.summaryPath}` };
          recordFailure(step, {
            kind: "runner",
            title: `shard ${step.shardId}`,
            error: result.error,
          });
        }
      }
      return { ...result, ...(cancelled ? { cancelled: true } : {}) };
    } finally {
      // 已完成的 shard 仍拥有其 HOME 下的孤儿；后续 peer 首错时也必须回收。
      if (step.kind !== "child") activeExecutions.delete(execution);
    }
  };

  const signalHandlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        interruptedBySignal ??= signal;
        terminateActiveExecutions();
      },
    ]),
  );
  for (const [signal, handler] of signalHandlers) signalSource.on(signal, handler);

  try {
    for (const buildStep of plan.buildSteps) {
      await runTrackedStep(buildStep);
      if (firstFailure || interruptedBySignal) break;
    }

    // 各 result 只等进程关闭，首错由同步通知或单个退出结果立即触发，不能等 Promise.all。
    const childResults = await Promise.all(
      plan.children.map(async (child) => ({
        child,
        result: await runTrackedStep(child),
      })),
    );
    // 首错通知与取消已即时发出；只等自有进程回收，不等 afterAll/报告。
    await Promise.all(cleanupBarriers);
    const finishedAtMs = now();
    const manifest = {
      runId: plan.runId,
      shardTotal: plan.shardTotal,
      distributionKind: plan.distributionKind,
      wallDurationMs: finishedAtMs - startedAtMs,
      manifestPath: plan.manifestPath,
      ...(firstFailure ? { firstFailure } : {}),
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
      ...(interruptedBySignal ? { interruptedBySignal } : {}),
      children: childResults.map(({ child, result }) => ({
        shardId: child.shardId,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
        artifactDir: child.artifactDir,
        summaryPath: child.summaryPath,
        ...(child.specs ? { specs: child.specs } : {}),
        ...(child.estimatedWeightMs ? { estimatedWeightMs: child.estimatedWeightMs } : {}),
      })),
    };

    await writeManifest(plan.manifestPath, manifest);
    printManifest(manifest);

    if (firstFailure || interruptedBySignal) {
      const message = firstFailure
        ? `${firstFailure.title} ${firstFailure.error}`
        : `parent received ${interruptedBySignal}`;
      throw new WindowsE2EShardRunError(message, manifest);
    }

    return manifest;
  } finally {
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler);
  }
}

export async function runWindowsE2EShards({
  args = process.argv.slice(2),
  desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  env = process.env,
  platform = process.platform,
  repoRoot = resolve(desktopDir, "../.."),
} = {}) {
  // 修复原因：父级必须先采用与 WDIO 相同的本地环境优先级，再发现分片和选择共享构建，
  // 否则仅在 env 文件配置的 OMP 专项会被配平列表静默遗漏。
  env = { ...env };
  loadE2ELocalEnv({ desktopDir, repoRoot, env });
  const shardTotal = resolveWindowsE2EShardTotal({ args, env, platform });
  const useHistoricalWeights =
    shardTotal > 1 &&
    !isTargetedRun(args, env) &&
    !isManualReviewRun(args, env) &&
    env.E2E_PROVIDER_HTTP_MODE?.trim() !== "capture";
  let weightedSpecBuckets;
  if (useHistoricalWeights) {
    const durationProfile = JSON.parse(
      readFileSync(join(desktopDir, DEFAULT_SPEC_DURATION_PROFILE_PATH), "utf-8"),
    );
    weightedSpecBuckets = partitionE2ESpecsByWeight(
      listDefaultFormalE2ESpecs(desktopDir, env),
      shardTotal,
      durationProfile,
    );
  }
  const plan = createWindowsE2EShardPlan({
    args,
    desktopDir,
    env,
    platform,
    repoRoot,
    weightedSpecBuckets,
  });
  return await executeWindowsE2EShardPlan(plan);
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    await runWindowsE2EShards();
  } catch (error) {
    console.error(`[e2e-shards] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
