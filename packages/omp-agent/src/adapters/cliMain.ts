// omp-agent CLI 入口：argv 兼容 ZCode host 的拉起形态
//   `omp-agent app-server --stdio [--surface desktop] [--cwd <path>]`
//   `omp-agent app-server --stdio --prepare-storage --cwd <path>`（worker_threads 内亦走此路径）

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import { resolveOmpBinary } from "../contract.js";
import { ServerApp } from "../app/serverApp.js";
import { OmpProjectGateway } from "./ompProjectGateway.js";
import { ProtocolServer } from "./protocolServer.js";
import { emitStorageStartup, runPrepareStorageWorker } from "./storageStartupFrames.js";
import { createOmpProcessFactory } from "./ompProcess.js";
import { createOmpStore } from "./ompStore.js";
import { createWorkspaceConfigLoader } from "./workspaceConfig.js";
import { logger } from "./logger.js";

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
  const { flags, cwd: cwdArg, positional } = parseArgs(argv);
  const cwd = cwdArg ?? process.cwd();
  if (flags.has("--prepare-storage")) {
    const storagePath = prepareStoragePath(env);
    await runPrepareStorageWorker({ input: process.stdin, output: process.stdout, storagePath });
    return;
  }
  if (positional !== "app-server" && positional !== "agent-server") {
    logger.error("unsupported invocation", { positional: positional ?? null });
    process.exitCode = 1;
    return;
  }
  const ompBinaryPath = resolveOmpBinary(env);
  if (!ompBinaryPath) {
    // omp 核缺失时仍满足 storage gate（ready），再以明确错误回应业务请求，便于 host 侧诊断。
    emitStorageStartup(process.stdout);
    logger.error("内嵌 omp 二进制未找到（OMP_RPC_BINARY_PATH 可覆盖）");
    process.exitCode = 1;
    return;
  }
  emitStorageStartup(process.stdout);
  const workspacePath = cwd;
  const workspaceKey = env.ZCODE_WORKSPACE_IDENTITY?.trim() || workspacePath;
  const gatewayRef: { server: ProtocolServer | null } = { server: null };
  const ompExtraArgs = buildOmpExtraArgs(env);
  const ompFactory = createOmpProcessFactory(ompBinaryPath, ompExtraArgs);
  // 目录进程的 available_commands_update → ServerApp 缓存 + workspace-config topic 推送。
  // 构造顺序上 loader 先于 app，用 ref 解引用。
  const appRef: { app: ServerApp | null } = { app: null };
  // OMP 项目模式网关（omp-project-mode.md）：懒启动；ready 无项目模式时整体回落旧拓扑。
  const projectGateway = new OmpProjectGateway({
    binaryPath: ompBinaryPath,
    extraArgs: ompExtraArgs,
    cwd: workspacePath,
    onCatalogChanged: () => {
      // 命令目录失效：清缓存重读（下一次 loadWorkspaceConfig/技能目录查询取新值）。
      appRef.app?.invalidateWorkspaceConfigCache();
    },
  });
  // sessions_changed：OMP 目录事实变化 → 重扫冷会话并推送 sessions-index 增量。
  // 进程退出 → 清理注册表通道登记（引擎已按各自通道 onExit 终结轮次）。
  const wireProjectHooks = (appInstance: ServerApp) => {
    projectGateway.setEventHooks({
      onSessionsChanged: () => void appInstance.registry.onProjectSessionsChanged().catch(() => {}),
    });
  };
  const workspaceCatalog = createWorkspaceConfigLoader(ompFactory, workspacePath, {
    onCommandsUpdate: (commands) => appRef.app?.updateSlashCommands(commands),
    project: projectGateway,
  });
  const app = new ServerApp({
    ompFactory,
    store: createOmpStore(env),
    gateway: {
      emitFrame: (params) => gatewayRef.server?.emitFrame(params),
      requestUserInput: (params) =>
        gatewayRef.server?.requestUserInput(params) ??
        Promise.resolve({ action: "cancel" as const }),
      requestPermission: (params) =>
        gatewayRef.server?.requestPermission(params) ??
        Promise.resolve({ decision: "deny" as const }),
    },
    workspacePath,
    workspaceKey,
    loadWorkspaceConfig: workspaceCatalog.loadWorkspaceConfig,
    loadWorkspaceSkillCommands: workspaceCatalog.loadSkillCommands,
    // v3 fork surface 工作区级查询（模型连通性实测、MCP 状态）复用同一目录 omp 进程。
    testModelConnectivity: workspaceCatalog.testModel,
    listMcpServers: workspaceCatalog.listMcpServers,
    project: projectGateway,
  });
  appRef.app = app;
  wireProjectHooks(app);
  const protocolServer = new ProtocolServer({
    input: process.stdin,
    output: process.stdout,
    handleRequest: (method, params) => app.handleRequest(method, params),
    onClosed: (error) => {
      if (error) logger.error("Host 传输关闭", { error: error.message });
      void app.dispose().finally(() => process.exit(error ? 1 : 0));
    },
  });
  gatewayRef.server = protocolServer;
  protocolServer.start();
  logger.info("omp-agent app-server 就绪", { workspacePath, ompBinaryPath });
}

/**
 * omp 启动参数装配（纯函数，UT 覆盖参数矩阵）。
 * CentOS 7 启动参数分别透传给 omp；profile 值与 GUI 历史使用同一选择
 * （desktop main 先把 OMPCODE_CENTOS7_PROFILE 复制到 OMP_PROFILE，此处按 OMP_PROFILE/PI_PROFILE 解析）。
 */
export function buildOmpExtraArgs(env: NodeJS.ProcessEnv): string[] {
  const centos7Offline = env.OMPCODE_CENTOS7_OFFLINE === "1";
  const launchProfile = env.OMPCODE_CENTOS7_PROFILE;
  const profile = launchProfile ? resolveOmpProfileFromEnv(env) : null;
  // OMP_RPC_ARGS_JSON：开发/测试用的附加 omp 启动参数（如 fake 核心脚本路径）。
  return [
    ...parseExtraArgs(env.OMP_RPC_ARGS_JSON),
    ...(centos7Offline ? ["--offline"] : []),
    ...(profile ? ["--profile", profile] : []),
  ];
}

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((arg): arg is string => typeof arg === "string")
      : [];
  } catch {
    return [];
  }
}

function prepareStoragePath(env: NodeJS.ProcessEnv): string {
  // host 只用它做锁/复用记账；omp 核没有该库，路径保持与旧 CLI 一致以便复用判定。
  const home = env.PI_CONFIG_DIR?.trim() || join(homedir(), ".ompcode");
  const directory = join(home, "cli", "db");
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // 只读文件系统等场景：host 会 realpath 失败回退原路径，不阻塞。
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
  void runCliMain(process.argv).catch((error) => {
    logger.error("omp-agent 启动失败", {
      error: error instanceof Error ? error.stack : String(error),
    });
    process.exit(1);
  });
}
