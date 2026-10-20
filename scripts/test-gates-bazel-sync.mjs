import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, matchesGlob, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fastPlan, slowPlan } from "./test-gates-plan.mjs";
import { workspaceBuildPlan } from "./test-gates-workspace-plan.mjs";
import { parsedCompilerConfig } from "./test-gates-build-outputs.mjs";
import { workspacePackageManifests } from "./test-gates-workspace-metadata.mjs";
import {
  bazelizeStages,
  bazelTargetName,
  isBuildStage,
  isUncachedStage,
} from "./test-gates-bazel.mjs";
import { createSourceDependencyAnalyzer } from "./test-gates-source-dependencies.mjs";
import { createStageEntrypointReader, staticModuleInputs } from "./test-gates-static-modules.mjs";
import { graphStage } from "./test-gates-bazel-graph.mjs";
import { excludes, rootFiles, repositoryGlobIncludes } from "./test-gates-bazel-graph-inputs.mjs";

const ts = createRequire(import.meta.url)("@typescript/typescript6");
const workspace = resolve(".");
const stageEntrypoints = createStageEntrypointReader(workspace);

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a pathname`);
  return value;
};
const output = argument("--output") ?? "BUILD.bazel";
const changedFilesControl = argument("--changed-files-control");
const changedFiles = changedFilesControl
  ? JSON.parse(await readFile(changedFilesControl, "utf8")).stage.changedFiles
  : undefined;
if (changedFilesControl && !Array.isArray(changedFiles))
  throw new Error("Graph control requires stage.changedFiles");
const manifests = await workspacePackageManifests();
const names = new Map([...manifests].map(([directory, manifest]) => [manifest.name, directory]));
const edges = new Map();
const packageConfigs = new Map();
const configEntries = new Map();
const directories = [...manifests.keys()];
for (let offset = 0; offset < directories.length; offset += 8) {
  const batch = directories.slice(offset, offset + 8);
  const entries = await Promise.all(batch.map((directory) => readdir(join("packages", directory))));
  for (let index = 0; index < batch.length; index++)
    configEntries.set(batch[index], entries[index]);
}
for (const [directory, manifest] of manifests) {
  const dependencies = new Set(
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })
      .map((name) => names.get(name))
      .filter(Boolean),
  );
  // 复用 TypeScript 官方解析器跟踪 references 和 extends（含数组及包配置），不手写 JSON 正则。
  for (const entry of configEntries.get(directory)) {
    if (!/^tsconfig.*\.json$/u.test(entry)) continue;
    const { config, parsed, readFiles } = parsedCompilerConfig(
      resolve("packages", directory, entry),
    );
    const configs = new Set(readFiles);
    if (!packageConfigs.has(directory)) packageConfigs.set(directory, []);
    packageConfigs.get(directory).push({ path: config, files: parsed.fileNames });
    for (const reference of parsed.projectReferences ?? []) configs.add(reference.path);
    for (const config of configs) {
      const path = relative(workspace, config).replaceAll("\\", "/");
      const target = path.match(/^packages\/([^/]+)/u)?.[1];
      if (target && manifests.has(target)) dependencies.add(target);
    }
  }
  edges.set(directory, dependencies);
}
function sourcePackages(stage) {
  const found = new Set();
  const outputRoots = /^(?:build|bootstrap):/u.test(stage.id) ? (stage.outputs ?? []) : [];
  for (const text of [
    stage.id,
    stage.testFile ?? "",
    ...(stage.args ?? []),
    ...(stage.sourceRoots ?? []),
    ...outputRoots,
  ]) {
    for (const match of String(text).matchAll(/packages[\\/]([^/\\\s]+)/gu))
      if (manifests.has(match[1])) found.add(match[1]);
    const directory = names.get(String(text).replace(/^--filter=/u, ""));
    if (directory) found.add(directory);
  }
  const core = stage.id.match(/^(.+)-core-tests$/u)?.[1];
  if (manifests.has(core)) found.add(core);
  if (stage.lifecycle || stage.electron) {
    found.add("desktop");
    found.add("omp-agent");
  }
  if (stage.realOmp) {
    found.add("omp-agent");
    found.add("services");
  }
  const queue = [...found];
  while (queue.length)
    for (const dependency of edges.get(queue.pop()) ?? [])
      if (!found.has(dependency)) {
        found.add(dependency);
        queue.push(dependency);
      }
  return [...found].sort();
}
const stages = [
  ...bazelizeStages([...(await fastPlan({ changedFiles })), ...(await slowPlan())]).flatMap(
    (group) => group.bazel.stages,
  ),
  ...(await workspaceBuildPlan({ bootstrap: false })),
  ...(await workspaceBuildPlan({ bootstrap: true })),
];
// Runnable entries are separate inputs for file tests and identifiable runtime/
// product targets, including their producers. Global audits keep broad scopes.
const entryPatterns = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map(
  (extension) => `**/*.test.${extension}`,
);
const runnableEntries = new Set(
  ts.sys.readDirectory(workspace, undefined, excludes, entryPatterns).map(repoPath),
);
function hasMetadataContract(stage) {
  const entries = stageEntrypoints(stage);
  return (
    stage.semanticHead === true &&
    entries.length === 1 &&
    entries[0] === "packages/desktop/scripts/build-metadata.mjs"
  );
}
function prunesEntries(stage) {
  return Boolean(
    stage.testFile ||
    (isBuildStage(stage) && stage.parallelGroup !== "static") ||
    (stage.kind === "test" &&
      !stage.args?.includes("--self-test") &&
      stageEntrypoints(stage).length),
  );
}
for (const stage of stages)
  if (stage.kind === "test" && (stage.electron || stage.lifecycle || stage.file))
    for (const entry of stageEntrypoints(stage)) runnableEntries.add(entry);
const fileExcludes = [...excludes, ...entryPatterns, ...[...runnableEntries].sort()];
const codePatterns = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map(
  (extension) => `packages/**/*.${extension}`,
);
const retainedCodePatterns = ["test", "tests", "fixtures", "__fixtures__", "config"]
  .flatMap((directory) =>
    codePatterns.map((pattern) => pattern.replace("**/", `**/${directory}/**/`)),
  )
  .concat(codePatterns.map((pattern) => pattern.replace("**/*.", "**/*.config.")));
// Pattern sets are fixed for this generation; classify a path only when needed.
const sourcePatterns = {
  code: codePatterns,
  excluded: fileExcludes,
  retained: retainedCodePatterns,
};
const sourceClassifications = new Map();
function sourceMatches(input, kind) {
  let fact = sourceClassifications.get(input);
  if (!fact) sourceClassifications.set(input, (fact = {}));
  return (fact[kind] ??= sourcePatterns[kind].some((pattern) => matchesGlob(input, pattern)));
}
const analyzeSources = createSourceDependencyAnalyzer({
  workspace,
  excludes,
  codePatterns,
  runnableEntries,
});
function fileDependencies(stage) {
  return analyzeSources({
    testFile: stage.testFile,
    args: stage.args,
    packages: sourcePackages(stage),
    runtime: !isBuildStage(stage),
    metadata: hasMetadataContract(stage),
  });
}

// Assemble each stage's entry/lifecycle/producer analyses once. The underlying
// analyzer caches file facts; both input emission and fallback selection consume
// this same closure rather than independently rediscovering dependencies.
const stageSourceCache = new Map();
function stageSourceDependencies(stage) {
  if (stageSourceCache.has(stage)) return stageSourceCache.get(stage);
  const inputs = new Set(stage.sourceInputs ?? []);
  let conservative = false;
  function include(entry, args = stage.args) {
    const analysis = fileDependencies({ ...stage, testFile: entry, args });
    conservative ||= analysis.conservative;
    for (const input of analysis.inputs) inputs.add(input);
  }
  for (const entry of stageEntrypoints(stage)) include(entry);
  if (isBuildStage(stage) && !hasMetadataContract(stage)) {
    for (const directory of sourcePackages(stage))
      for (const config of packageConfigs.get(directory) ?? [])
        for (const file of config.files) {
          const entry = repoPath(file);
          if (runnableEntries.has(entry)) include(entry, ["--tsconfig", config.path]);
        }
  }
  const result = { inputs, conservative };
  stageSourceCache.set(stage, result);
  return result;
}

function repoPath(path) {
  return relative(workspace, path).replaceAll("\\", "/");
}

function stageInputs(stage) {
  // 显式实际读盘契约/元数据只消费自身闭包；配置和工具链仍由公共声明保留。
  if (stage.sourceInputs || hasMetadataContract(stage))
    return [...stageSourceDependencies(stage).inputs].sort();
  if (!prunesEntries(stage)) return [];
  const entries = new Set(stageEntrypoints(stage));
  const packages = sourcePackages(stage);
  const precise = stage.testFile && !stageSourceDependencies(stage).conservative;
  const { inputs } = stageSourceDependencies(stage);
  // 产品源码/配置/fixture 仍由各产品 scope 共享；scripts/gates 不再有公共
  // glob，入口静态闭包及实际读盘得到的这些路径必须逐目标显式保留。
  return [...inputs]
    .filter((input) => {
      if (entries.has(input) || runnableEntries.has(input)) return true;
      if (input.startsWith("scripts/") || input.startsWith("gates/") || input === "BUILD.bazel")
        return true;
      if (precise && sourceMatches(input, "code") && !sourceMatches(input, "retained")) return true;
      if (rootFiles.includes(input)) return false;
      const covered =
        !packages.length ||
        packages.some((directory) => input.startsWith(`packages/${directory}/`));
      return !covered || sourceMatches(input, "excluded");
    })
    .sort();
}
const unique = new Map();
for (const stage of stages) {
  const target = bazelTargetName(stage.id);
  if (unique.has(target) && unique.get(target).id !== stage.id)
    throw new Error(`Bazel target collision ${target}`);
  unique.set(target, stage);
}
const scopes = new Map([["repo", ["**/*"]]]);
const scopeOf = new Map();
for (const [target, stage] of unique) {
  if (stage.sourceInputs) {
    if (!scopes.has("command")) scopes.set("command", rootFiles);
    scopeOf.set(target, "command");
    continue;
  }
  if (hasMetadataContract(stage)) {
    if (!scopes.has("metadata")) scopes.set("metadata", ["packages/desktop/package.json"]);
    scopeOf.set(target, "metadata");
    continue;
  }
  const packages = sourcePackages(stage);
  const base = packages.length ? `pkg-${packages.join("-")}` : "repo";
  const key =
    stage.testFile && !stageSourceDependencies(stage).conservative
      ? `resources-${base}`
      : prunesEntries(stage)
        ? `files-${base}`
        : base;
  if (!scopes.has(key))
    scopes.set(
      key,
      packages.length ? packages.map((directory) => `packages/${directory}/**`) : ["**/*"],
    );
  scopeOf.set(target, key);
}
const repoIncludes = await repositoryGlobIncludes(workspace);
const runnableScopeExcludes = [...fileExcludes, "scripts/**", "gates/**", "BUILD.bazel"];
const resourceScopeExcludes = [...runnableScopeExcludes, ...codePatterns];
const fileScopeIncludes = scopes.has("files-repo")
  ? repoIncludes
  : [
      ...new Set(
        [...scopes].filter(([key]) => key.startsWith("files-")).flatMap(([, includes]) => includes),
      ),
    ].sort();
function retainedPatterns(includes) {
  return includes.flatMap((include) =>
    retainedCodePatterns.map((pattern) =>
      include === "**/*" ? pattern : pattern.replace("packages/**/", `${include.slice(0, -3)}/**/`),
    ),
  );
}
const resourcePackageIncludes = [
  ...new Set(
    [...scopes]
      .filter(([key]) => key.startsWith("resources-") && key !== "resources-repo")
      .flatMap(([, includes]) => includes),
  ),
].sort();
const lines = [
  "# Generated by scripts/test-gates-bazel-sync.mjs; source scopes follow workspace manifests and tsconfig references.",
  'load("//:gates/rules.bzl", "gate_test", "gate_action", "gate_source_scopes")',
  "",
  // 排除的根树不必递归遍历；点目录、未知目录和目录符号链接仍由原生 glob 发现。
  `_REPOSITORY_FILES = glob(${JSON.stringify(repoIncludes)}, exclude = ${JSON.stringify(excludes)}, allow_empty = True)`,
  "_REPOSITORY_SCOPES = gate_source_scopes(_REPOSITORY_FILES)",
  "",
];
if (fileScopeIncludes.length)
  lines.push(
    // 所有包组合共享一次文件分类，避免为每组依赖闭包重做递归 glob。
    `_FILE_SCOPES = gate_source_scopes(glob(${JSON.stringify(fileScopeIncludes)}, exclude = ${JSON.stringify(runnableScopeExcludes)}, allow_empty = True))`,
    "",
  );
if (resourcePackageIncludes.length)
  lines.push(
    // 保留代码仍按包内相对路径匹配，不能把名为 test/config 的包根误当作 fixture。
    `_RESOURCE_SCOPES = gate_source_scopes(glob(${JSON.stringify(resourcePackageIncludes)}, exclude = ${JSON.stringify(resourceScopeExcludes)}, allow_empty = True) + glob(${JSON.stringify([...new Set(retainedPatterns(resourcePackageIncludes))])}, exclude = ${JSON.stringify(fileExcludes)}, allow_empty = True))`,
    "",
  );
// 全仓集合已包含根配置；只有包分区仍需显式依赖根配置。
for (const [key, includes] of scopes) {
  // 内联准备原先没有文件入口，被错误归入全仓 scope；只对完整声明的读盘契约收窄。
  if (key === "command") {
    lines.push(`filegroup(name = "src-${key}", srcs = ${JSON.stringify(includes)})`, "");
    continue;
  }
  if (key === "repo") {
    lines.push('filegroup(name = "src-repo", srcs = _REPOSITORY_FILES)', "");
    continue;
  }
  const precise = key.startsWith("resources-");
  const fileScope = precise || key.startsWith("files-");
  const rootScope = key === "files-repo" || key === "resources-repo";
  if (key === "metadata" || key === "resources-repo") {
    // 根资源 scope 的保留模式不同于包内模式，保持原生匹配语义，不扩大输入集合。
    lines.push(
      `filegroup(name = "src-${key}", srcs = glob(${JSON.stringify(rootScope ? repoIncludes : includes)}, exclude = ${JSON.stringify(precise ? resourceScopeExcludes : excludes)}${rootScope ? ", allow_empty = True" : ""})${precise ? ` + glob(${JSON.stringify(retainedPatterns(includes))}, exclude = ${JSON.stringify(fileExcludes)}, allow_empty = True)` : ""} + ${JSON.stringify(rootScope ? [] : rootFiles)})`,
      "",
    );
    continue;
  }
  const partition = precise
    ? "_RESOURCE_SCOPES"
    : fileScope
      ? "_FILE_SCOPES"
      : "_REPOSITORY_SCOPES";
  const sources = rootScope
    ? `${partition}[""]`
    : includes
        .map((include) => `${partition}.get(${JSON.stringify(include.slice(9, -3))}, [])`)
        .join(" + ");
  lines.push(
    `filegroup(name = "src-${key}", srcs = ${sources} + ${JSON.stringify(rootScope ? [] : rootFiles)})`,
    "",
  );
}
// 构建/测试包装器各自共享完整本地静态闭包（含跨包 helper），不共享其动态
// fixture 读盘，也不因生成器或不相干脚本变化让所有目标失效。
for (const [key, entry] of [
  ["build", "scripts/test-gates-action.mjs"],
  ["test", "scripts/test-gates-bazel-exec.mjs"],
]) {
  const inputs = staticModuleInputs(workspace, [entry]);
  lines.push(`filegroup(name = "src-${key}-runner", srcs = ${JSON.stringify(inputs)})`, "");
}
lines.push('filegroup(name = "gate-toolchain", srcs = ["gates/toolchain.json"])', "");
// 图输入复用同一全仓集合，仅剔除生成物 BUILD；根目录分区由同一生成所有者自动更新。
lines.push(
  'filegroup(name = "src-bazel-graph", srcs = [source for source in _REPOSITORY_FILES if source != "BUILD.bazel"])',
  "",
  "gate_action(",
  `    name = ${JSON.stringify(bazelTargetName(graphStage.id))},`,
  `    stage = ${JSON.stringify(bazelTargetName(graphStage.id))},`,
  `    data = ${JSON.stringify([`gates/inputs/${bazelTargetName(graphStage.id)}.json`, ":gate-toolchain", ":src-bazel-graph"])},`,
  ")",
  "",
);
// Only consumers with an unprovable entry/lifecycle/producer closure get this
// fallback. It includes ordinary helpers as well as runnable entries, without
// restoring a public scripts glob to precise tests or metadata targets.
lines.push(
  'filegroup(name = "src-conservative-scripts", srcs = [source for source in _REPOSITORY_FILES if source.startswith("scripts/") or source.startswith("gates/")])',
  "",
);
for (const [target, stage] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
  const dependencies = stage.dependsOn ?? [];
  const data = [
    `gates/inputs/${target}.json`,
    ":gate-toolchain",
    isBuildStage(stage) || stage.preparation ? ":src-build-runner" : ":src-test-runner",
    `:src-${scopeOf.get(target)}`,
    ...(!hasMetadataContract(stage) && stageSourceDependencies(stage).conservative
      ? [":src-conservative-scripts"]
      : []),
    ...stageInputs(stage),
    ...dependencies.map((id) => `:${bazelTargetName(id)}`),
  ];
  // Dependency controls are runtime recipes for restoring action trees before a
  // dependent command. Their semantic contents must also be native inputs.
  for (const id of dependencies) data.push(`gates/inputs/${bazelTargetName(id)}.json`);
  const noCache = isUncachedStage(stage);
  // exclusive 交给 Bazel 原生调度：声明该测试目标须在无其他测试并发时单独执行；
  // 这里只映射计划属性，不新增任何外层调度器。
  const tags = [
    ...(noCache ? ["no-cache", "no-remote"] : []),
    ...(stage.exclusive ? ["exclusive"] : []),
  ];
  lines.push(
    `${isBuildStage(stage) ? "gate_action" : "gate_test"}(`,
    `    name = ${JSON.stringify(target)},`,
    `    stage = ${JSON.stringify(target)},`,
    ...(!isBuildStage(stage) ? ['    timeout = "eternal",'] : []),
    ...(stage.preparation ? ["    preparation = True,"] : []),
    `    data = ${JSON.stringify([...new Set(data)])},`,
    ...(tags.length ? [`    tags = ${JSON.stringify(tags)},`] : []),
    ")",
    "",
  );
}
const generated = lines.join("\n");
let existing;
try {
  existing = await readFile(output, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing !== generated) await writeFile(output, generated);
console.log(
  `${output} regenerated: ${unique.size + 1} native targets; ${scopes.size} dependency scopes`,
);
