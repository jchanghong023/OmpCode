import { join } from "node:path";
import { resolveOmpCodeDataRoot } from "@zcode/shared/node";
import { getZCodeDataRootDir } from "#src/paths.js";

export interface SubagentStorageOptions {
  homeDir?: string;
}

export async function resolveUserSubagentRoot(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "agents");
}

export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "agents");
}

export async function resolveSubagentStateFile(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "v2", "agents-state.json");
}

export async function resolveZCodeStorageRoot(options?: SubagentStorageOptions): Promise<string> {
  // 原因：读取旧 HOME/.zcode/cli/config.json 会让子代理迁移写入上游，绕过应用根所有者。
  // 生产复用已固定的应用根；显式 homeDir 只用于隔离 fixture，不读取旧 storage.dir。
  return options?.homeDir?.trim()
    ? resolveOmpCodeDataRoot({}, options.homeDir)
    : getZCodeDataRootDir();
}
