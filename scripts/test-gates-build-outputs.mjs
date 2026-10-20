import { workspaceRootManifest } from "./test-gates-workspace-metadata.mjs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
// The installed compiler is TS7 (native CLI); TS6 supplies the compatible public
// tsconfig parser, not a second compiler invocation or hand-maintained file list.
const ts = require("@typescript/typescript6");
const workspace = resolve(import.meta.dirname, "..");
// 同一入口会构造多级计划；配置元数据只读且最终快照校验负责拒绝运行中的源码变化。
const parsedConfigs = new Map();
const configTexts = new Map();

// The generator consumes the same parse as output discovery, including every
// config read (extends may be an array or a package) and included source file.
// Keep recoverable diagnostics on the result: dependency discovery retains its
// existing tolerance, while compiler output planning rejects them below.
export function parsedCompilerConfig(path) {
  let config = resolve(workspace, path);
  if (!config.endsWith(".json")) config = resolve(config, "tsconfig.json");
  if (parsedConfigs.has(config)) return parsedConfigs.get(config);
  const readFiles = new Set();
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      readFile(path) {
        const absolute = resolve(path);
        readFiles.add(absolute);
        if (!configTexts.has(absolute)) configTexts.set(absolute, ts.sys.readFile(absolute));
        return configTexts.get(absolute);
      },
      onUnRecoverableConfigFileDiagnostic(error) {
        throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
      },
    },
  );
  const result = { config, parsed, readFiles };
  parsedConfigs.set(config, result);
  return result;
}

function workspacePath(path) {
  const value = relative(workspace, path).replaceAll("\\", "/");
  if (!value || value.startsWith("../") || isAbsolute(value))
    throw new Error(`Build output is outside workspace: ${path}`);
  return value;
}

export async function compilerOutputs(configPaths, { build = false, noEmit = false } = {}) {
  const outputs = new Set();
  const visited = new Set();
  function visit(path) {
    const { config, parsed } = parsedCompilerConfig(path);
    if (visited.has(config)) return;
    visited.add(config);
    if (parsed.errors.length)
      throw new Error(
        parsed.errors
          .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
          .join("\n"),
      );
    const options = {
      ...parsed.options,
      configFilePath: config,
      ...(noEmit ? { noEmit: true } : {}),
    };
    if (!options.noEmit && options.outDir) outputs.add(workspacePath(options.outDir));
    if (build || options.incremental || options.composite) {
      const buildInfo = ts.getTsBuildInfoEmitOutputFilePath({ ...options, incremental: true });
      if (buildInfo) outputs.add(workspacePath(buildInfo));
    }
    if (build) for (const reference of parsed.projectReferences ?? []) visit(reference.path);
  }
  for (const config of configPaths) visit(config);
  return [...outputs]
    .sort()
    .filter((path, _index, paths) => !paths.some((parent) => path.startsWith(`${parent}/`)));
}

export async function annotateBuildOutputs(stages) {
  const root = await workspaceRootManifest();
  const typecheckProjects = root.scripts.typecheck
    .split(/\s+/u)
    .slice(2)
    .filter((arg) => !arg.startsWith("-"));
  const known = {
    "adapter-build": ["packages/omp-agent/dist/omp-agent.cjs"],
    "adapter-stage": [
      `packages/desktop/bundled-agents/${process.platform}-${process.arch}/glm/omp-agent.cjs`,
      `packages/desktop/bundled-agents/${process.platform}-${process.arch}/glm/.node-bundle-meta.json`,
    ],
    "desktop-build-metadata": ["packages/desktop/out/metadata/build-meta.json"],
    "desktop-main-host-preload-build": [
      "packages/desktop/out/main",
      "packages/desktop/out/host",
      "packages/desktop/out/preload",
      "packages/desktop/out/scheduler",
      "packages/desktop/out/.main-build-ready",
      "packages/desktop/out/.host-build-ready",
      "packages/desktop/out/.preload-build-ready",
      "packages/desktop/out/.scheduler-build-ready",
    ],
    "desktop-renderer-build": ["packages/desktop/out/renderer"],
    "web-renderer-build": ["packages/web/dist"],
    "formal-proof-build": ["packages/formal-proof/dist"],
    "server-http-build": ["packages/server/dist"],
    "server-cli-build": ["packages/zcode-server-cli/dist"],
    "server-remote-build-validation": ["packages/server/dist/remote"],
  };
  for (const stage of stages) {
    if (known[stage.id]) stage.outputs = known[stage.id];
    if (stage.id === "typecheck")
      stage.outputs = await compilerOutputs(typecheckProjects, { build: true });
    if (stage.id === "formal-proof-typecheck")
      stage.outputs = await compilerOutputs(["packages/formal-proof"], { noEmit: true });
    if (stage.id === "model-option-map-build")
      stage.outputs = await compilerOutputs(["packages/model-option-map"]);
    if (stage.id === "desktop-build-metadata") stage.semanticHead = true;
    if (stage.id === "adapter-stage") stage.dependsOn = ["adapter-build"];
    if (stage.id.startsWith("desktop-") && stage.kind === "compile")
      stage.dependsOn = ["desktop-build-metadata"];
    if (stage.realOmp) stage.dependsOn = [...(stage.dependsOn ?? []), "adapter-stage"];
    if (stage.electron || stage.fixture || stage.lifecycle)
      stage.dependsOn = [
        ...new Set([
          ...(stage.dependsOn ?? []),
          "adapter-stage",
          "desktop-main-host-preload-build",
          "desktop-renderer-build",
        ]),
      ];
    if (stage.packaging)
      stage.dependsOn = [
        "adapter-stage",
        "desktop-main-host-preload-build",
        "desktop-renderer-build",
        "web-renderer-build",
        "formal-proof-build",
        "model-option-map-build",
        "server-http-build",
        "server-cli-build",
        "server-remote-build-validation",
      ];
  }
  return stages;
}
