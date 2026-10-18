import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const nativePromptConfigPath = (configRoot) => join(configRoot, "native-prompt.yml");

// Execute the same public black-box process-factory contract as realOmpNativeCache.test.ts.
// The TypeScript helper imports that contract without reading its implementation.
export async function queryNativeCatalog({ root, workspace, configRoot, env: additions }) {
  assert.ok(process.env.OMP_RPC_BINARY_PATH, "The gate must supply the actual OMP binary");
  const promptConfig = nativePromptConfigPath(configRoot);
  // Only this isolated fixture's prompt listing is off; real skill discovery and calls remain on.
  await writeFile(promptConfig, "skillful: false\n");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(key) ||
      /^(?:OMP_AUTH_BROKER_.+|PI_CONFIG_FILES|CLAUDE_CONFIG_DIR|OMP_OFFLINE|OMP_SKILLS_DIR|OMP_WIKI_DIR|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|ELECTRON_RUN_AS_NODE)$/iu.test(
        key,
      ) ||
      /^(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL$/iu.test(key)
    )
      delete env[key];
  }
  Object.assign(env, additions, {
    OMP_CONFIG_ROOT: configRoot,
    OMP_PROFILE: "",
    PI_PROFILE: "",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    PI_NATIVES_DIR: join(root, "native-catalog-cache"),
  });
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      fileURLToPath(new URL("./ompNativeAcceptance.catalog.ts", import.meta.url)),
      workspace,
      promptConfig,
    ],
    {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const records = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.startsWith("NATIVE_CATALOG=")) records.push(line.slice("NATIVE_CATALOG=".length));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const code = await new Promise((resolveClose, reject) => {
      child.once("error", reject);
      child.once("close", resolveClose);
    });
    assert.equal(code, 0, `Actual read-only OMP directory helper failed: ${stderr}`);
    assert.equal(records.length, 1, "One exact real catalog result, not an empty query or replay");
    const commands = JSON.parse(records[0]);
    assert.ok(Array.isArray(commands) && commands.length >= 4);
    return commands;
  } finally {
    lines.close();
  }
}
