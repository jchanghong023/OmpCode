import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeOmpProfileName } from "@zcode/shared/omp-profile";
import { resolveOmpConfigRoot } from "@zcode/shared/node";

export { resolveOmpAgentDir } from "@zcode/shared/node";

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
