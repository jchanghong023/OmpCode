import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { repositoryRoot } from "./test-gates-bazel-locations.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const needsElectron = (stage) =>
  Boolean(stage.electron || stage.lifecycle || stage.packaging);
const normalize = (value) =>
  typeof value === "string"
    ? value
        .split(repositoryRoot)
        .join("${WORKSPACE}")
        .split(repositoryRoot.replaceAll("\\", "/"))
        .join("${WORKSPACE}")
    : value;
const semanticKey =
  /^(?:ZCODE_|OMP_|OMPCODE_|PI_|CLAUDE_|CI$|NODE_ENV$|NODE_OPTIONS$|ELECTRON_|PLAYWRIGHT_|VITE_|CSC_|WIN_CSC_|TZ$|LANG$|LC_)/iu;

export async function buildStageControl(stage, context, runtimeToolchain) {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => {
        if (!semanticKey.test(key)) return false;
        if (
          !/^(?:build|bootstrap):/u.test(stage.id) &&
          /^ZCODE_(?:BUILTIN|PERSONAL)_PROVIDER_CONFIG_FILE$/iu.test(key)
        )
          return false;
        if (key === "OMP_RPC_BINARY_PATH") return false; // content identity is in toolchain
        if (
          stage.realOmp &&
          /^(?:OMP_RPC_ARGS_JSON|OMP_E2E_MODEL_SELECTOR|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_FILES|OMP_AUTH_BROKER_.+|CLAUDE_CONFIG_DIR|OMP_OFFLINE|(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL)$/iu.test(
            key,
          )
        )
          return false;
        return true;
      })
      .map(([key, value]) => [key, normalize(value)]),
  );
  const recipe = { ...stage, command: stage.command === process.execPath ? "node" : stage.command };
  delete recipe.parallelGroup;
  if (recipe.lifecycle)
    recipe.lifecycle = recipe.lifecycle.map((phase) => {
      const semantic = { ...phase };
      delete semantic.parallelGroup;
      return semantic;
    });
  if (recipe.semanticHead) recipe.head = context.snapshot?.head ?? context.head;
  const control = { stage: recipe, env };
  control.toolchain = {
    ...(stage.realOmp ? { omp: runtimeToolchain.omp } : {}),
    ...(needsElectron(stage) ? { electron: runtimeToolchain.electron } : {}),
  };
  // External configuration content participates even when its stable pathname does not change.
  const files = {};
  for (const [key, value] of Object.entries({ ...env, ...stage.env })) {
    if (
      typeof value !== "string" ||
      !/(?:FILE|PATH|ROOT)$/iu.test(key) ||
      key === "OMP_RPC_BINARY_PATH"
    )
      continue;
    try {
      files[key] = digest(await readFile(value.replaceAll("${WORKSPACE}", repositoryRoot)));
    } catch (error) {
      if (!["ENOENT", "EISDIR", "EINVAL"].includes(error.code)) throw error;
    }
  }
  control.configurationFiles = files;
  return control;
}
