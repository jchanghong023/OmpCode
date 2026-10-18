import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

// Replace only pnpm's process boundary; keep real graph aggregation and comparisons.
// The microtask boundary makes overlapping graph reads observable without timers or pnpm.
let state;
async function listPackages(_command, args, options) {
  state.active += 1;
  state.maxActive = Math.max(state.maxActive, state.active);
  try {
    await Promise.resolve();
    const graph = args.includes("--lockfile-only") ? state.locked : state.installed;
    const projects = args.includes("-r") ? [...graph.values()] : [graph.get(options.cwd)];
    return {
      stdout: JSON.stringify(
        args.includes("--prod") ? projects : projects.map(({ name, path }) => ({ name, path })),
      ),
    };
  } finally {
    state.active -= 1;
  }
}
const originalExecFile = childProcess.execFile;
const fakeExecFile = () => {
  throw new Error("Expected the promisified pnpm process boundary");
};
fakeExecFile[promisify.custom] = listPackages;
let readWorkspaceProductionGraph;
let missingProductionPackages;
try {
  childProcess.execFile = fakeExecFile;
  syncBuiltinESMExports();
  ({ readWorkspaceProductionGraph, missingProductionPackages } =
    await import("./third-party-npm.mjs?graph-regression"));
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}

const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-license-graph-")));
await mkdir(join(root, "node_modules"));
after(() => rm(root, { recursive: true, force: true }));
const alpha = join(root, "packages", "alpha");
const beta = join(root, "packages", "space & 项目");
async function resetGraphs() {
  // Deliberately unsorted discovery, including a dependency-free workspace node.
  const projects = [
    {
      name: "@zcode/beta",
      path: beta,
      optionalDependencies: {
        shared: { version: "2.0.0", optionalDependencies: { nested: { version: "3.0.0" } } },
      },
    },
    { name: "zcode", path: root, dependencies: { "root-only": { version: "1.0.0" } } },
    {
      name: "@zcode/alpha",
      path: alpha,
      dependencies: {
        shared: { version: "1.0.0" },
        "@zcode/beta": { version: "link:../space & 项目" },
      },
      devDependencies: { "dev-only": { version: "9.0.0" } },
    },
    { name: "@zcode/empty", path: join(root, "packages", "empty") },
  ];
  state = {
    active: 0,
    maxActive: 0,
    locked: new Map(projects.map((project) => [project.path, project])),
    installed: new Map(projects.map((project) => [project.path, structuredClone(project)])),
    lockfile: { packages: {}, snapshots: {} },
    modules: { skipped: [] },
    workspace: {
      supportedArchitectures: {
        os: ["current", "darwin", "linux", "win32"],
        cpu: ["current", "x64", "arm64"],
      },
    },
  };
  await writeMetadata();
}

async function writeMetadata() {
  await Promise.all([
    writeFile(join(root, "pnpm-lock.yaml"), JSON.stringify(state.lockfile)),
    writeFile(join(root, "node_modules/.modules.yaml"), JSON.stringify(state.modules)),
    writeFile(join(root, "pnpm-workspace.yaml"), JSON.stringify(state.workspace)),
  ]);
}

async function addTypeScriptPeer() {
  // Like the real Lexical snapshots, a production package resolves the root dev tool
  // as an optional peer. pnpm's JSON flattens those optional edges into dependencies.
  const native = {
    "@typescript/typescript-aix-ppc64": { os: ["aix"], cpu: ["ppc64"] },
    "@typescript/typescript-win32-x64": { os: ["win32"], cpu: ["x64"] },
    "@typescript/typescript-linux-arm64": { os: ["linux"], cpu: ["arm64"] },
  };
  const typescript = {
    version: "7.0.2",
    dependencies: Object.fromEntries(
      Object.keys(native).map((name) => [name, { version: "7.0.2" }]),
    ),
  };
  state.locked.get(root).devDependencies = { typescript };
  state.locked.get(alpha).dependencies.lexical = {
    version: "0.51.0",
    dependencies: { typescript },
  };
  state.installed = new Map(
    [...state.locked].map(([path, project]) => [path, structuredClone(project)]),
  );
  for (const [name, metadata] of Object.entries(native)) {
    state.lockfile.packages[`${name}@7.0.2`] = metadata;
    state.lockfile.snapshots[`${name}@7.0.2`] = { optional: true };
  }
  state.modules.skipped = ["@typescript/typescript-aix-ppc64@7.0.2"];
  await writeMetadata();
}

test("workspace graph aggregation stays bounded and compares every production version", async (t) => {
  await t.test(
    "retains all manifests, root, nested and optional dependencies across projects",
    async () => {
      await resetGraphs();
      const result = await readWorkspaceProductionGraph(root);
      assert.equal(state.maxActive, 1);
      assert.deepEqual([...result.required.keys()].sort(), [
        "nested@3.0.0",
        "root-only@1.0.0",
        "shared@1.0.0",
        "shared@2.0.0",
      ]);
      assert.deepEqual(
        result.projects.map((project) => project.path),
        [...state.installed.keys()].sort((a, b) => a.localeCompare(b, "en")),
      );
    },
  );
  await t.test("detects a missing optional subtree in a later workspace", async () => {
    await resetGraphs();
    delete state.installed.get(beta).optionalDependencies.shared;
    await assert.rejects(readWorkspaceProductionGraph(root), (error) => {
      assert.match(error.message, /Missing: .*shared@2\.0\.0.*nested@3\.0\.0/u);
      return true;
    });
    assert.equal(state.maxActive, 1);
  });
  await t.test(
    "rejects an installed version drift rather than matching only package names",
    async () => {
      await resetGraphs();
      state.installed.get(beta).optionalDependencies.shared.version = "2.1.0";
      await assert.rejects(readWorkspaceProductionGraph(root), (error) => {
        assert.match(error.message, /Missing: shared@2\.0\.0/u);
        assert.match(error.message, /Stale: shared@2\.1\.0/u);
        return true;
      });
      assert.equal(state.maxActive, 1);
    },
  );
  await t.test(
    "does not promote root dev tools or hoisted unsaved dependencies into production",
    async () => {
      await resetGraphs();
      const typescript = {
        version: "7.0.2",
        dependencies: { "@typescript/typescript-aix-ppc64": { version: "7.0.2" } },
      };
      state.locked.get(root).devDependencies = { typescript };
      state.installed.get(root).devDependencies = { typescript };
      state.installed.get(alpha).unsavedDependencies = { typescript };
      const { required } = await readWorkspaceProductionGraph(root);
      assert.deepEqual([...required.keys()].sort(), [
        "nested@3.0.0",
        "root-only@1.0.0",
        "shared@1.0.0",
        "shared@2.0.0",
      ]);
    },
  );
  await t.test(
    "records only confirmed non-applicable optional artifacts without dropping the production peer",
    async () => {
      await resetGraphs();
      await addTypeScriptPeer();
      const { required, skippedPackages } = await readWorkspaceProductionGraph(root);
      assert.ok(required.has("typescript@7.0.2"));
      assert.ok(required.has("@typescript/typescript-aix-ppc64@7.0.2"));
      assert.ok(required.has("@typescript/typescript-linux-arm64@7.0.2"));
      assert.deepEqual([...skippedPackages], ["@typescript/typescript-aix-ppc64@7.0.2"]);
      const installed = new Map(required);
      installed.delete("@typescript/typescript-aix-ppc64@7.0.2");
      assert.deepEqual(missingProductionPackages(required, installed, skippedPackages), [
        { name: "@typescript/typescript-aix-ppc64", version: "7.0.2" },
      ]);
      // Cross-target artifacts are required even when this host cannot load them.
      installed.delete("@typescript/typescript-linux-arm64@7.0.2");
      assert.throws(
        () => missingProductionPackages(required, installed, skippedPackages),
        /Missing installed dependency: @typescript\/typescript-linux-arm64@7\.0\.2/u,
      );
    },
  );
  await t.test(
    "allows a confirmed platform omission from the installed graph, not a supported-target omission",
    async () => {
      await resetGraphs();
      await addTypeScriptPeer();
      const native =
        state.installed.get(alpha).dependencies.lexical.dependencies.typescript.dependencies;
      delete native["@typescript/typescript-aix-ppc64"];
      const { required } = await readWorkspaceProductionGraph(root);
      assert.ok(required.has("@typescript/typescript-aix-ppc64@7.0.2"));
      state.modules.skipped.push("@typescript/typescript-linux-arm64@7.0.2");
      await writeMetadata();
      delete native["@typescript/typescript-linux-arm64"];
      await assert.rejects(
        readWorkspaceProductionGraph(root),
        /Missing: @typescript\/typescript-linux-arm64@7\.0\.2/u,
      );
    },
  );
  await t.test(
    "does not excuse non-optional or unrecorded missing packages, or stale platform versions",
    async () => {
      await resetGraphs();
      await addTypeScriptPeer();
      const key = "@typescript/typescript-aix-ppc64@7.0.2";
      state.lockfile.snapshots[key].optional = false;
      await writeMetadata();
      let result = await readWorkspaceProductionGraph(root);
      let installed = new Map(result.required);
      installed.delete(key);
      assert.throws(
        () => missingProductionPackages(result.required, installed, result.skippedPackages),
        /Missing installed dependency: @typescript\/typescript-aix-ppc64@7\.0\.2/u,
      );
      state.lockfile.snapshots[key].optional = true;
      state.modules.skipped = [];
      await writeMetadata();
      result = await readWorkspaceProductionGraph(root);
      assert.throws(
        () => missingProductionPackages(result.required, installed, result.skippedPackages),
        /Missing installed dependency: @typescript\/typescript-aix-ppc64@7\.0\.2/u,
      );
      state.modules.skipped = [key];
      await writeMetadata();
      state.installed.get(alpha).dependencies.lexical.dependencies.typescript.dependencies[
        "@typescript/typescript-aix-ppc64"
      ].version = "7.0.3";
      await assert.rejects(
        readWorkspaceProductionGraph(root),
        /Stale: @typescript\/typescript-aix-ppc64@7\.0\.3/u,
      );
    },
  );
});
