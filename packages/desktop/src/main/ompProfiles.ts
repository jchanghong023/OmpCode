import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeOmpProfileName, resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";

export function resolveOmpConfigRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return resolve(home, env.PI_CONFIG_DIR?.trim() || ".omp");
}

export function resolveOmpAgentDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const profile = resolveOmpProfileFromEnv(env);
  const root = resolveOmpConfigRoot(home, env);
  return profile === "default"
    ? join(root, "agent")
    : join(root, "profiles", profile, "agent");
}

export async function listOmpProfiles(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  try {
    const entries = await readdir(join(resolveOmpConfigRoot(home, env), "profiles"), {
      withFileTypes: true,
    });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          return normalizeOmpProfileName(name) === name && name !== "default";
        } catch {
          return false;
        }
      })
      .sort();
    return ["default", ...names];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return ["default"];
    }
    throw error;
  }
}
