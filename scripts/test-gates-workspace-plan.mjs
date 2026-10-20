import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compilerOutputs } from "./test-gates-build-outputs.mjs";

// Package primitives remain unchanged; Bazel exclusively owns their ordering,
// parallelism, product identity and successful action reuse.
export async function workspaceBuildPlan({ bootstrap = false, target } = {}) {
  const packages = new Map();
  for (const entry of await readdir(new URL("../packages/", import.meta.url), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(new URL(`../packages/${entry.name}/package.json`, import.meta.url), "utf8"),
      );
      packages.set(manifest.name, { manifest, directory: `packages/${entry.name}` });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const buildable = new Map([...packages].filter(([, value]) => value.manifest.scripts?.build));
  function dependencies(name, visited = new Set()) {
    if (visited.has(name)) return [];
    visited.add(name);
    const manifest = packages.get(name)?.manifest;
    if (!manifest) return [];
    const direct = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    }).filter((dependency) => packages.has(dependency));
    return direct.flatMap((dependency) => [
      ...(buildable.has(dependency) ? [dependency] : []),
      ...dependencies(dependency, visited),
    ]);
  }
  if (target && !buildable.has(target))
    throw new Error(`Unknown buildable workspace target: ${target}`);
  const selected = target ? new Set([target, ...dependencies(target)]) : new Set(buildable.keys());
  const terminalIds = (name) =>
    name === "@zcode/desktop"
      ? ["build:desktop-main-host-preload", "build:desktop-renderer"]
      : [`build:${name}`];
  const stages = [];
  for (const [name, { manifest, directory }] of buildable) {
    if (!selected.has(name)) continue;
    const prerequisiteNames = new Set(
      dependencies(name).filter((dependency) => dependency !== name && selected.has(dependency)),
    );
    const dependsOn = [...prerequisiteNames].sort().flatMap(terminalIds);
    if (name === "@zcode/desktop") {
      if (!bootstrap)
        stages.push({
          id: "build:desktop-runtime-assets",
          command: "node",
          args: ["packages/desktop/scripts/prepare-runtime-assets.mjs"],
          kind: "check",
          noCache: true,
          dependsOn,
        });
      const metadata = "build:desktop-metadata";
      // Assets are external mutable preparation, not compilation. Metadata and
      // cleaning retain the original lifecycle order, including clean's opt-out.
      stages.push({
        id: metadata,
        command: "node",
        args: ["packages/desktop/scripts/build-metadata.mjs"],
        kind: "check",
        semanticHead: true,
        outputs: ["packages/desktop/out/metadata/build-meta.json"],
        // 元数据不消费包构建产物；下方 depth 屏障保留原顺序，不能把排序当缓存输入。
        dependsOn: [],
      });
      const clean = "build:desktop-clean";
      stages.push({
        id: clean,
        command: "node",
        action: true,
        args: [
          "--input-type=module",
          "--eval",
          "import { cleanDesktopProductionOutput } from './packages/desktop/scripts/run-production-build.mjs'; import { resolve } from 'node:path'; await cleanDesktopProductionOutput({ cwd: resolve('packages/desktop') });",
        ],
        kind: "check",
        noCache: true,
        outputs: [],
        dependsOn: [metadata],
      });
      for (const [id, args, outputs] of [
        [
          "build:desktop-main-host-preload",
          ["tsup"],
          [
            "main",
            "host",
            "preload",
            "scheduler",
            ".main-build-ready",
            ".host-build-ready",
            ".preload-build-ready",
            ".scheduler-build-ready",
          ],
        ],
        ["build:desktop-renderer", ["vite", "build"], ["renderer"]],
      ])
        stages.push({
          id,
          command: "pnpm",
          args: ["--filter", name, "exec", ...args],
          kind: "compile",
          env: { NODE_ENV: "production" },
          outputs: outputs.map((output) => `packages/desktop/out/${output}`),
          dependsOn: [...dependsOn, metadata, clean],
        });
      continue;
    }
    const script = manifest.scripts.build;
    const outputs = /\b(?:vite|tsup)\b/u.test(script)
      ? [`${directory}/dist`]
      : await compilerOutputs([join(directory, "tsconfig.json")]);
    stages.push({
      id: `build:${name}`,
      command: "pnpm",
      args: ["--filter", name, "build"],
      kind: /build:remote/u.test(script) ? "check" : "compile",
      outputs,
      dependsOn,
    });
  }
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const depths = new Map();
  const visiting = new Set();
  function depth(stage) {
    if (depths.has(stage.id)) return depths.get(stage.id);
    if (visiting.has(stage.id)) throw new Error(`Cyclic workspace build dependency: ${stage.id}`);
    visiting.add(stage.id);
    let value = Math.max(-1, ...stage.dependsOn.map((id) => depth(byId.get(id)))) + 1;
    if (stage.id === "build:desktop-metadata") {
      // Runtime preparation is not a product input. The outer native group
      // barrier orders it without poisoning shared build/bootstrap action keys.
      // Bootstrap retains its all-non-desktop completion barrier.
      const packageDepth = Math.max(
        -1,
        ...stages
          .filter((candidate) => !candidate.id.startsWith("build:desktop-"))
          .map((candidate) => depth(candidate)),
      );
      value = Math.max(value, packageDepth + (bootstrap ? 1 : 2));
    }
    visiting.delete(stage.id);
    depths.set(stage.id, value);
    return value;
  }
  for (const stage of stages) stage.parallelGroup = `workspace-build-${depth(stage)}`;
  return stages.sort(
    (left, right) => depths.get(left.id) - depths.get(right.id) || left.id.localeCompare(right.id),
  );
}
