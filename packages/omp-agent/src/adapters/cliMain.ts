// omp-agent CLI 入口：argv 兼容 ZCode host 的拉起形态
//   `omp-agent app-server --stdio [--surface desktop] [--cwd <path>]`
//   `omp-agent app-server --stdio --prepare-storage --cwd <path>`（worker_threads 内亦走此路径）

import { logger } from "./logger.js";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import { resolveOmpConfigRoot } from "@zcode/shared/node";
import { resolveOmpBinary } from "../contract.js";
import { ServerApp } from "../app/serverApp.js";
import { OmpDirectoryGateway } from "./ompDirectoryGateway.js";
import { ProtocolServer } from "./protocolServer.js";
import { emitStorageStartup, runPrepareStorageWorker } from "./storageStartupFrames.js";
import { createOmpProcessFactory } from "./ompProcess.js";
import { createOmpStore } from "./ompStore.js";
import { createWorkspaceConfigLoader } from "./workspaceConfig.js";
import { createSlashCommandResolver } from "../app/slashCommandResolver.js";
import { safeErrorSummary } from "./hostRequestDiagnostics.js";

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  let cwd: string | undefined;
  let positional: string | undefined;
  // --surface desktop 等「flag + 值」形态：值不能被误认成入口动词
  //（GUI 链路实测踩坑：positional 被 desktop 覆盖后进程拒绝启动）。
  const flagsWithValue = new Set(["--cwd"]);
  let skipNextValue = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
    if (arg === "--cwd") {
      cwd = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--")) {
      flags.add(arg.replace(/=.*$/, ""));
      if (!arg.includes("=") && flagsWithValue.has(arg.replace(/=.*$/, ""))) {
        skipNextValue = true;
      }
    } else if (arg === "app-server" || arg === "agent-server") {
      positional = arg;
    }
  }
  return { flags, cwd, positional };
}

export async function runCliMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const startedAt = Date.now();
  logger.info("omp-agent 启动", {
    event: "agent.cli.started",
    stage: "startup",
    argumentCount: argv.length,
  });
  try {
    const { flags, cwd: cwdArg, positional } = parseArgs(argv);
    const cwd = cwdArg ?? process.cwd();
    if (flags.has("--prepare-storage")) {
      const storagePath = prepareStoragePath(env);
      await runPrepareStorageWorker({ input: process.stdin, output: process.stdout, storagePath });
      logger.info("存储准备 worker 已停止", {
        event: "agent.cli.stopped",
        mode: "prepare-storage",
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    if (positional !== "app-server" && positional !== "agent-server") {
      logger.error("unsupported invocation", {
        event: "agent.cli.failed",
        stage: "arguments",
        code: "unsupported_invocation",
        elapsedMs: Date.now() - startedAt,
      });
      process.exitCode = 1;
      return;
    }
    const ompBinaryPath = resolveOmpBinary(env);
    if (!ompBinaryPath) {
      // omp 核缺失时仍满足 storage gate（ready），再以明确错误回应业务请求，便于 host 侧诊断。
      emitStorageStartup(process.stdout);
      logger.error("内嵌 omp 二进制未找到（OMP_RPC_BINARY_PATH 可覆盖）", {
        event: "agent.cli.failed",
        stage: "resolve_binary",
        code: "omp_binary_missing",
        elapsedMs: Date.now() - startedAt,
      });
      process.exitCode = 1;
      return;
    }
    emitStorageStartup(process.stdout);
    const workspacePath = cwd;
    const workspaceKey = env.ZCODE_WORKSPACE_IDENTITY?.trim() || workspacePath;
    const gatewayRef: { server: ProtocolServer | null } = { server: null };
    const ompExtraArgs = buildOmpExtraArgs(env);
    const ompFactory = createOmpProcessFactory(ompBinaryPath, ompExtraArgs, env);
    // 目录进程的 available_commands_update → ServerApp 缓存 + workspace-config topic 推送，
    // 同时失效斜杠严格分发的目录缓存。构造顺序上 loader/resolver 先于 app，用 ref 解引用。
    const appRef: { app: ServerApp | null } = { app: null };
    const directoryGateway = new OmpDirectoryGateway({
      ompFactory,
      cwd: workspacePath,
      onCommandsUpdate: (commands) => {
        slashResolver.invalidate();
        appRef.app?.updateSlashCommands(commands);
      },
    });
    const slashResolver = createSlashCommandResolver(directoryGateway);
    const workspaceCatalog = createWorkspaceConfigLoader(workspacePath, {
      directory: directoryGateway,
      onCommandsUpdate: (commands) => appRef.app?.updateSlashCommands(commands),
    });
    const app = new ServerApp({
      ompFactory,
      store: createOmpStore(env),
      gateway: {
        emitFrame: (params) => gatewayRef.server?.emitFrame(params),
        requestUserInput: (params) =>
          gatewayRef.server?.requestUserInput(params) ??
          Promise.resolve({ action: "cancel" as const }),
      },
      workspacePath,
      workspaceKey,
      loadWorkspaceConfig: workspaceCatalog.loadWorkspaceConfig,
      loadWorkspaceSkillCommands: workspaceCatalog.loadSkillCommands,
      directory: directoryGateway,
      resolveSlashCommand: slashResolver.resolve,
    });
    appRef.app = app;
    const protocolServer = new ProtocolServer({
      input: process.stdin,
      output: process.stdout,
      handleRequest: (method, params) => app.handleRequest(method, params),
      onClosed: (error) => {
        const stoppingAt = Date.now();
        logger.info("omp-agent 正在停止", {
          event: "agent.cli.stopping",
          stage: "disconnect",
          transportFailed: Boolean(error),
        });
        if (error)
          logger.error("Host 传输关闭", {
            event: "agent.cli.transport.failed",
            stage: "disconnect",
            ...safeErrorSummary(error),
          });
        void app
          .dispose()
          .catch((disposeError) => {
            logger.error("omp-agent 清理失败", {
              event: "agent.cli.dispose.failed",
              stage: "dispose",
              elapsedMs: Date.now() - stoppingAt,
              ...safeErrorSummary(disposeError),
            });
            throw disposeError;
          })
          .finally(() => {
            logger.info("omp-agent 已停止", {
              event: "agent.cli.stopped",
              stage: "dispose",
              elapsedMs: Date.now() - stoppingAt,
            });
            process.exit(error ? 1 : 0);
          });
      },
    });
    gatewayRef.server = protocolServer;
    protocolServer.start();
    logger.info("omp-agent app-server 就绪", {
      event: "agent.cli.ready",
      workspacePath,
      ompBinaryPath,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("omp-agent 启动失败", {
      event: "agent.cli.failed",
      stage: "startup",
      elapsedMs: Date.now() - startedAt,
      ...safeErrorSummary(error),
    });
    throw error;
  }
}

/**
 * omp 启动参数装配（纯函数，UT 覆盖参数矩阵）。
 * profile 值与 GUI 历史使用同一选择；OMP_OFFLINE 直接随环境继承，不转成已移除的参数。
 * （desktop main 先把 OMPCODE_CENTOS7_PROFILE 复制到 OMP_PROFILE，此处按 OMP_PROFILE/PI_PROFILE 解析）。
 */
export function buildOmpExtraArgs(env: NodeJS.ProcessEnv): string[] {
  const launchProfile = env.OMPCODE_CENTOS7_PROFILE;
  const profile = launchProfile ? resolveOmpProfileFromEnv(env) : null;
  // OMP_RPC_ARGS_JSON：开发/测试用的附加 omp 启动参数（如 fake 核心脚本路径）。
  return [...parseExtraArgs(env.OMP_RPC_ARGS_JSON), ...(profile ? ["--profile", profile] : [])];
}

function parseExtraArgs(raw: string | undefined): string[] {
  const startedAt = Date.now();
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("OMP 启动参数不是数组，沿用空参数", {
        event: "agent.cli.arguments.invalid",
        stage: "decode",
        valueType: typeof parsed,
        elapsedMs: Date.now() - startedAt,
      });
      return [];
    }
    const args = parsed.filter((arg): arg is string => typeof arg === "string");
    if (args.length !== parsed.length)
      logger.warn("OMP 启动参数含非字符串，沿用过滤结果", {
        event: "agent.cli.arguments.invalid",
        stage: "decode",
        argumentCount: parsed.length,
        retainedCount: args.length,
        elapsedMs: Date.now() - startedAt,
      });
    return args;
  } catch {
    logger.warn("OMP 启动参数解码失败，沿用空参数", {
      event: "agent.cli.arguments.invalid",
      stage: "decode",
      byteLength: Buffer.byteLength(raw),
      elapsedMs: Date.now() - startedAt,
    });
    return [];
  }
}

function prepareStoragePath(env: NodeJS.ProcessEnv): string {
  // host 只用它做锁/复用记账；omp 核没有该库，路径保持与旧 CLI 一致以便复用判定。
  const root = resolveOmpConfigRoot(homedir(), {
    ...env,
    PI_CONFIG_DIR: env.PI_CONFIG_DIR?.trim() || ".ompcode",
  });
  const directory = join(root, "cli", "db");
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    // 只读文件系统等场景：host 会 realpath 失败回退原路径，不阻塞。
    logger.warn("存储目录准备失败，沿用路径", {
      event: "agent.cli.storage.fallback",
      stage: "mkdir",
      ...safeErrorSummary(error),
    });
  }
  return join(directory, "db.sqlite");
}

// 直接执行（非测试导入）时启动。worker_threads（--prepare-storage）里 argv[1] 可能缺斜杠
// 与文件名，不能只看 argv[1]；以「任意参数是入口动词/含 bundle 文件名」判定。
const argvText = process.argv.join(" ");
const isDirectRun =
  argvText.includes("omp-agent.cjs") ||
  argvText.includes("cliMain.ts") ||
  process.argv.includes("app-server") ||
  process.argv.includes("agent-server") ||
  process.argv.includes("--prepare-storage");
if (isDirectRun && !process.env.OMP_AGENT_NO_AUTO_START) {
  void runCliMain(process.argv).catch(() => {
    process.exit(1);
  });
}
