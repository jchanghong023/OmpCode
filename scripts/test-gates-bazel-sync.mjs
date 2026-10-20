import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, matchesGlob, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fastPlan, slowPlan } from "./test-gates-plan.mjs";
import { workspaceBuildPlan } from "./test-gates-workspace-plan.mjs";
import {
  bazelizeStages,
  bazelTargetName,
  isBuildStage,
  isUncachedStage,
} from "./test-gates-bazel.mjs";
import { createSourceDependencyAnalyzer } from "./test-gates-source-dependencies.mjs";
import { createStageEntrypointReader, staticModuleInputs } from "./test-gates-static-modules.mjs";

const ts = createRequire(import.meta.url)("@typescript/typescript6");
const workspace = resolve(".");
const stageEntrypoints = createStageEntrypointReader(workspace);

const excludes = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-*/**",
  "**/out/**",
  "**/*.tsbuildinfo",
  "**/coverage/**",
  "**/.git",
  ".git",
  "**/.git/**",
  ".git/**",
  "bazel-*/**",
  "bazel-*",
  "gates/inputs/**",
  "gates/toolchain.json",
  ".gates-bazel/**",
  ".worktrees/**",
  ".tmp*/**",
  ".run-logs/**",
  ".zcode-runtime/**",
  "**/bundled-agents/**",
  "**/bundled-resources/**",
  "**/bundled-tools/**",
  "**/.e2e-*/**",
  "**/mock-cdn/**",
  "**/.test-real-e2e-workspace/**",
  "**/.omp-release-cache/**",
  ".cache/**",
  ".pnpm-store/**",
  ".electron-builder-cache/**",
  ".electron-cache/**",
  ".npm-cache/**",
  "prebuilds/**",
  "z-work/**",
  "openclaw/**",
  "apps/**",
];
const rootFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "mise.toml",
  "tsconfig.base.json",
  ".oxlintrc.json",
  ".env.example",
  ".env.development",
  ".env.production",
];
const manifests = new Map();
for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    manifests.set(
      entry.name,
      JSON.parse(await readFile(join("packages", entry.name, "package.json"), "utf8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const names = new Map([...manifests].map(([directory, manifest]) => [manifest.name, directory]));
const edges = new Map();
const packageConfigs = new Map();
const configTextCache = new Map();
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
  for (const entry of await readdir(join("packages", directory))) {
    if (!/^tsconfig.*\.json$/u.test(entry)) continue;
    const configs = new Set();
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve("packages", directory, entry),
      {},
      {
        ...ts.sys,
        readFile(path) {
          configs.add(path);
          const absolute = resolve(path);
          if (!configTextCache.has(absolute)) configTextCache.set(absolute, ts.sys.readFile(path));
          return configTextCache.get(absolute);
        },
        onUnRecoverableConfigFileDiagnostic(error) {
          throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
        },
      },
    );
    if (!packageConfigs.has(directory)) packageConfigs.set(directory, []);
    packageConfigs.get(directory).push({
      path: resolve("packages", directory, entry),
      files: parsed?.fileNames ?? [],
    });
    for (const reference of parsed?.projectReferences ?? []) configs.add(reference.path);
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
  ...bazelizeStages([...(await fastPlan()), ...(await slowPlan())]).flatMap(
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

function repoPath(path) {
  return relative(workspace, path).replaceAll("\\", "/");
}

function hasPreciseSources(stage) {
  return Boolean(stage.testFile && !fileDependencies(stage).conservative);
}
function stageInputs(stage) {
  if (hasMetadataContract(stage)) {
    // collectBuildMetadata's explicit product contract reads only manifests,
    // installed tooling identity and HEAD, not product sources or fixtures.
    // HEAD/toolchain identity remains owned by the existing stage/toolchain.
    const inputs = new Set();
    for (const entry of stageEntrypoints(stage))
      for (const input of fileDependencies({ ...stage, testFile: entry }).inputs) inputs.add(input);
    return [...inputs].sort();
  }
  if (!prunesEntries(stage)) return [];
  const inputs = new Set();
  const entries = new Set(stageEntrypoints(stage));
  const packages = sourcePackages(stage);
  const precise = hasPreciseSources(stage);
  for (const entry of entries)
    for (const input of fileDependencies({ ...stage, testFile: entry }).inputs) inputs.add(input);
  if (isBuildStage(stage)) {
    // A producer can legitimately compile a test entry. Preserve every entry
    // selected by its packages' parsed configs, including project references
    // already represented by sourcePackages' dependency closure.
    for (const directory of packages)
      for (const config of packageConfigs.get(directory) ?? [])
        for (const file of config.files) {
          const entry = repoPath(file);
          if (!runnableEntries.has(entry)) continue;
          for (const input of fileDependencies({
            ...stage,
            testFile: entry,
            args: ["--tsconfig", config.path],
          }).inputs)
            inputs.add(input);
        }
  }
  // The shared filegroups already own ordinary source/config/fixture inputs.
  // Keep explicit entries plus dependencies outside those globs, rather than
  // repeating the full product import closure on every target.
  return [...inputs]
    .filter((input) => {
      if (entries.has(input) || runnableEntries.has(input)) return true;
      if (
        precise &&
        codePatterns.some((pattern) => matchesGlob(input, pattern)) &&
        !retainedCodePatterns.some((pattern) => matchesGlob(input, pattern))
      )
        return true;
      if (rootFiles.includes(input)) return false;
      const covered =
        !packages.length ||
        input.startsWith("scripts/") ||
        input.startsWith("gates/") ||
        packages.some((directory) => input.startsWith(`packages/${directory}/`));
      return !covered || fileExcludes.some((pattern) => matchesGlob(input, pattern));
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
const scopes = new Map([
  ["repo", ["**/*"]],
  ["runner", ["scripts/**", "gates/**"]],
  ["runner-files", ["scripts/**", "gates/**"]],
]);
const scopeOf = new Map();
for (const [target, stage] of unique) {
  if (hasMetadataContract(stage)) {
    const key = "metadata";
    if (!scopes.has(key)) scopes.set(key, ["packages/desktop/package.json"]);
    scopeOf.set(target, key);
    continue;
  }
  const packages = sourcePackages(stage);
  const base = packages.length ? `pkg-${packages.join("-")}` : "repo";
  const key = hasPreciseSources(stage)
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
// Partition the repository glob at the root so Bazel need not walk subtrees
// already wholly excluded. Keep symlinks/unknown entry types: Bazel, not Node,
// decides whether they expose source files or cross a package boundary.
const excludedRootTrees = excludes.flatMap((pattern) => {
  if (!pattern.endsWith("/**")) return [];
  const segment = pattern.startsWith("**/") ? pattern.slice(3, -3) : pattern.slice(0, -3);
  if (!segment || segment.includes("/") || segment === "**") return [];
  const expression = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return [{ segment, expression: new RegExp(`^${expression}$`, "u") }];
});
const repoIncludes = [
  "*",
  ...(await readdir(workspace, { withFileTypes: true }))
    .filter(
      (entry) =>
        !entry.isFile() &&
        !excludedRootTrees.some(
          ({ segment, expression }) =>
            (!entry.name.startsWith(".") || segment === "*" || segment.startsWith(".")) &&
            expression.test(entry.name),
        ),
    )
    .map((entry) => `${entry.name}/**`)
    .sort(),
];
const lines = [
  "# Generated by scripts/test-gates-bazel-sync.mjs; source scopes follow workspace manifests and tsconfig references.",
  'load("//:gates/rules.bzl", "gate_test", "gate_action")',
  "",
];
// 全仓 glob 已包含根配置；再拼接会触发 Bazel duplicate label，包作用域仍需显式依赖根配置。
for (const [key, includes] of scopes) {
  const precise = key.startsWith("resources-");
  const fileScope = precise || key.startsWith("files-") || key === "runner-files";
  const sharedCode = precise
    ? includes.flatMap((include) =>
        retainedCodePatterns.map((pattern) =>
          include === "**/*"
            ? pattern
            : pattern.replace("packages/**/", `${include.slice(0, -3)}/**/`),
        ),
      )
    : [];
  const scopeExcludes = precise
    ? [...fileExcludes, ...codePatterns]
    : fileScope
      ? fileExcludes
      : excludes;
  const rootScope = ["repo", "files-repo", "resources-repo"].includes(key);
  const globIncludes =
    rootScope && includes.length === 1 && includes[0] === "**/*" ? repoIncludes : includes;
  lines.push(
    `filegroup(name = "src-${key}", srcs = glob(${JSON.stringify(globIncludes)}, exclude = ${JSON.stringify(scopeExcludes)}${rootScope ? ", allow_empty = True" : ""})${precise ? ` + glob(${JSON.stringify(sharedCode)}, exclude = ${JSON.stringify(fileExcludes)}, allow_empty = True)` : ""} + ${JSON.stringify(rootScope ? [] : rootFiles)})`,
    "",
  );
}
// 实际测试包装器跨包导入的 helper 必须共享失效，不能把动态 fixture 读盘扩大成全包输入。
const wrapperModules = staticModuleInputs(workspace, ["scripts/test-gates-bazel-exec.mjs"]).filter(
  (input) => !input.startsWith("scripts/") && !input.startsWith("gates/"),
);
lines.push(`filegroup(name = "src-test-wrapper", srcs = ${JSON.stringify(wrapperModules)})`, "");
lines.push('filegroup(name = "gate-toolchain", srcs = ["gates/toolchain.json"])', "");
for (const [target, stage] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
  const dependencies = stage.dependsOn ?? [];
  const data = [
    `gates/inputs/${target}.json`,
    ":gate-toolchain",
    prunesEntries(stage) ? ":src-runner-files" : ":src-runner",
    `:src-${scopeOf.get(target)}`,
    ...(!isBuildStage(stage) ? [":src-test-wrapper"] : []),
    ...stageInputs(stage),
    ...dependencies.map((id) => `:${bazelTargetName(id)}`),
  ];
  // Dependency controls are runtime recipes for restoring action trees before a
  // dependent command. Their semantic contents must also be native inputs.
  for (const id of dependencies) data.push(`gates/inputs/${bazelTargetName(id)}.json`);
  const noCache = isUncachedStage(stage);
  lines.push(
    `${isBuildStage(stage) ? "gate_action" : "gate_test"}(`,
    `    name = ${JSON.stringify(target)},`,
    `    stage = ${JSON.stringify(target)},`,
    ...(!isBuildStage(stage) ? ['    timeout = "eternal",'] : []),
    `    data = ${JSON.stringify([...new Set(data)])},`,
    ...(noCache ? ['    tags = ["no-cache", "no-remote"],'] : []),
    ")",
    "",
  );
}
const generated = lines.join("\n");
let existing;
try {
  existing = await readFile("BUILD.bazel", "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing !== generated) await writeFile("BUILD.bazel", generated);
console.log(
  `BUILD.bazel regenerated: ${unique.size} native targets; ${scopes.size} dependency scopes`,
);
