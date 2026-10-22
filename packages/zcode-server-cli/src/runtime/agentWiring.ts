import { access } from "node:fs/promises";
import { join } from "node:path";
import { verifyOmpArtifact } from "../../../../scripts/omp-artifact.mjs";

export interface BundledAgentWiring {
  ZCODE_AGENT_SERVER_COMMAND: string;
  ZCODE_AGENT_SERVER_ARGS_JSON: string;
}

export async function createReleaseAgentWiring(
  runtimeRoot: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.ZCODE_AGENT_SERVER_COMMAND !== undefined && !env.ZCODE_AGENT_SERVER_COMMAND.trim()) {
    throw new Error("ZCODE_AGENT_SERVER_COMMAND must not be empty");
  }
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) return null;
  const { command } = await verifyOmpArtifact(
    join(runtimeRoot, "omp"),
    `${process.platform}-${process.arch}`,
  );
  return {
    ZCODE_AGENT_SERVER_COMMAND: command,
    ZCODE_AGENT_SERVER_ARGS_JSON:
      env.ZCODE_AGENT_SERVER_ARGS_JSON ?? JSON.stringify(["app-server", "--stdio"]),
  };
}

/**
 * R3 SSH/WSL/Docker 使用同一 Source Server archive 的目标平台 OMP。
 * 原 Agent 源码与 TUI bundle 保留，但不能成为缺失或损坏 OMP 的运行回退。
 * 显式命令优先；没有发行资产的 monorepo 开发入口仍由 Host 自行解析。
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.ZCODE_AGENT_SERVER_COMMAND !== undefined && !env.ZCODE_AGENT_SERVER_COMMAND.trim()) {
    throw new Error("ZCODE_AGENT_SERVER_COMMAND must not be empty");
  }
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  try {
    await access(join(entryDir, "omp"));
  } catch {
    try {
      await access(join(entryDir, "zcode.cjs"));
    } catch {
      try {
        // stageRelease 写入的 runtime package marker 不因 OMP/legacy 入口被删而消失。
        await access(join(entryDir, "package.json"));
      } catch {
        return null;
      }
    }
  }
  return createReleaseAgentWiring(entryDir, env);
}
