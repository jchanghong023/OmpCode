/**
 * @zcode/omp-agent 公共契约。
 *
 * 本包是 Fork 的 Agent 核心适配器：对 ZCode host 冒充 agent（stdio 上的
 * ZCode Protocol 与 v4 数据面），对内嵌 omp 二进制说 omp RPC-UI（`omp --mode rpc-ui`）。
 * 跨模块只允许经本文件与包入口导入；实现细节见各层内部模块。
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 适配器进程的启动选项（由 CLI 入口从 argv/env 装配）。 */
export interface OmpAgentServerOptions {
  /** omp 可执行文件路径；缺省时按内嵌资源链解析。 */
  ompBinaryPath?: string;
  /** omp 附加启动参数（如 --provider/--model）。 */
  ompArgs?: string[];
  /** host 侧 stdio 是否已由父进程接好（当前恒为 true）。 */
  stdio: true;
}

function ompBinaryName(): string {
  return process.platform === "win32" ? "omp.exe" : "omp";
}

function currentModuleDir(): string {
  // esbuild CJS 产物里 import.meta 是 undefined（GUI 链路实测踩坑），双形态都要兼容。
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

function candidateDirectories(): string[] {
  const directories: string[] = [];
  let current = currentModuleDir();
  for (let depth = 0; depth < 8; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    directories.push(join(resourcesPath, "glm"));
  }
  return directories;
}

function candidateBinaryPaths(): string[] {
  const name = ompBinaryName();
  const platformKey = `${process.platform}-${process.arch}`;
  const paths: string[] = [];
  for (const directory of candidateDirectories()) {
    paths.push(
      join(directory, "omp", name),
      join(directory, "glm", "omp", name),
      // dev / 打包暂存目录：packages/desktop/bundled-agents/<platform>/glm/omp/
      join(directory, "bundled-agents", platformKey, "glm", "omp", name),
      join(directory, "desktop", "bundled-agents", platformKey, "glm", "omp", name),
      join(directory, "packages", "desktop", "bundled-agents", platformKey, "glm", "omp", name),
    );
  }
  return paths;
}

/**
 * 解析内嵌 omp 二进制：`OMP_RPC_BINARY_PATH` 供开发/测试显式覆盖；
 * 其余按「本模块向上找 `omp/` 资源目录 + Electron resourcesPath/glm/omp」解析内嵌拷贝。
 * 按需求（FORK.md）绝不查找 PATH 或用户已安装的 omp。
 */
export function resolveOmpBinary(env: NodeJS.ProcessEnv): string | null {
  const override = env.OMP_RPC_BINARY_PATH;
  if (override && override.trim().length > 0) {
    return override;
  }
  for (const candidate of candidateBinaryPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
