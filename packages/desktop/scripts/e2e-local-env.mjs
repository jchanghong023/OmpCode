import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export function loadE2ELocalEnv({ desktopDir, repoRoot, env }) {
  const envFiles = [
    resolve(desktopDir, ".env.e2e.local"),
    resolve(repoRoot, ".env.e2e.local"),
    // 仓库不再提供共享 key：.env.e2e.local.example 只列变量名、值留空，不作为 fallback 读取。
  ];
  for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
      continue;
    }

    const parsedEnv = {};
    const result = loadDotenv({
      path: envFile,
      processEnv: parsedEnv,
      quiet: true,
    });
    if (result.error) {
      throw new Error(`Failed to load e2e env file: ${envFile}`, {
        cause: result.error,
      });
    }
    for (const [key, value] of Object.entries(parsedEnv)) {
      if (!env[key]?.trim()) {
        env[key] = value;
      }
    }
  }
}
