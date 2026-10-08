import { readdir, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { exists, gitText } from "./test-gates-process.mjs";

const pnpm = (id, args, extra = {}) => ({ id, command: "pnpm", args, ...extra });
const node = (id, args, extra = {}) => ({ id, command: "node", args, ...extra });
export const guiPhases = {
  "ompAgentInteractions.gui.e2e.mjs": ["live", "cold"],
  "ompAgentInteractions.visual.e2e.mjs": ["visual"],
  "ompStatusPanels.gui.e2e.mjs": ["live", "cold"],
  "ompNativeCommands.gui.e2e.mjs": ["live", "capture", "cold"],
  "ompPerformanceHotPaths.gui.e2e.mjs": ["live", "stable", "cold"],
  "ompPerformanceHotPaths.mentions.e2e.mjs": ["mentions"],
  "ompReviewedDefects.gui.e2e.mjs": ["live", "recovery"],
  "ompProfile.gui.e2e.mjs": ["before", "after"],
  "ompRecovery.gui.e2e.mjs": ["recovery"],
};

async function filesAt(dir) {
  if (!(await exists(dir))) return [];
  return (await readdir(dir)).sort();
}

export async function installedOmp() {
  const candidates = [process.env.OMP_RPC_BINARY_PATH];
  if (process.platform === "win32") {
    candidates.push(
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "omp/omp.exe"),
    );
  }
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (directory)
      candidates.push(join(directory, process.platform === "win32" ? "omp.exe" : "omp"));
  }
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return candidate;
  return undefined;
}

export async function fastPlan() {
  const changed = [
    ...new Set([
      ...(await gitText(["diff", "--name-only", "-z", "HEAD"])).split("\0"),
      ...(await gitText(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
    ]),
  ].filter((name) => /\.(?:m?[jt]sx?|json|md|ya?ml|toml|css|html)$/u.test(name));
  const formatFiles = [];
  for (const name of changed) if (await exists(name)) formatFiles.push(name);
  return [
    pnpm("typecheck", ["typecheck"]),
    pnpm("lint", ["lint"]),
    pnpm("architecture-changed", ["architecture:check", "--changed"]),
    pnpm("quick-shared-client", [
      "exec",
      "tsx",
      "--test",
      "packages/shared/test/offlineGate.test.ts",
      "packages/shared/test/ompPaths.test.ts",
      "packages/client/test/websocketDisconnect.test.ts",
    ]),
    pnpm("quick-ui", [
      "exec",
      "tsx",
      "--tsconfig",
      "packages/ui/tsconfig.json",
      "--test",
      "packages/ui/test/composerSnapshot.test.ts",
      "packages/ui/test/ompModelRolesFallback.test.ts",
      "packages/ui/test/bufferedStreamingText.test.ts",
    ]),
    ...(formatFiles.length
      ? [pnpm("format-changed", ["exec", "oxfmt", "--check", ...formatFiles])]
      : []),
  ];
}

export async function fullPlan() {
  const stages = [
    pnpm("typecheck", ["typecheck"]),
    pnpm("lint", ["lint"]),
    pnpm("format-all", ["fmt:check"]),
    pnpm("architecture-all", ["architecture:check"]),
    pnpm("unused-dependencies-exports", ["knip"]),
    node("gate-entry-selftest", ["scripts/test-gates.mjs", "--self-test"]),
  ];
  const packages = (await readdir("packages", { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of packages) {
    const root = `packages/${entry.name}`;
    if (!(await exists(`${root}/package.json`))) continue;
    const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
    if (["formal-proof", "model-option-map"].includes(entry.name)) {
      for (const script of ["typecheck", "lint"])
        if (manifest.scripts?.[script])
          stages.push(pnpm(`${entry.name}-${script}`, ["--dir", root, script]));
    }
    const tests = (await filesAt(`${root}/test`)).filter((name) =>
      /\.(?:test|spec)\.(?:tsx?|mjs)$/u.test(name),
    );
    const ordinary = tests.filter(
      (name) => !["real-omp.e2e.test.ts", "realNativeCommands.e2e.test.ts"].includes(name),
    );
    if (ordinary.length)
      stages.push(
        pnpm(`${entry.name}-tests`, [
          "exec",
          "tsx",
          ...(entry.name === "ui" ? ["--tsconfig", "packages/ui/tsconfig.json"] : []),
          "--test",
          ...ordinary.map((name) => `${root}/test/${name}`),
        ]),
      );
    for (const file of tests.filter((name) => !ordinary.includes(name)))
      stages.push(
        pnpm(file, ["exec", "tsx", "--test", `${root}/test/${file}`], {
          realOmp: true,
          env: { OMP_NATIVE_E2E: "1" },
        }),
      );
    for (const file of (await filesAt(`${root}/test`)).filter((name) =>
      /\.perf\.(?:ts|mts)$/u.test(name),
    )) {
      stages.push(
        pnpm(
          file,
          [
            "exec",
            "tsx",
            ...(entry.name === "ui" ? ["--tsconfig", "packages/ui/tsconfig.json"] : []),
            `${root}/test/${file}`,
          ],
          { baseline: file === "workspaceFileIndex.perf.mts" },
        ),
      );
    }
  }
  stages.push(pnpm("workspace-build", ["build"], { realOmp: true }));
  if (process.platform === "win32")
    stages.push(
      pnpm("windows-local-package", ["bundle:desktop", "--", "--os=win", "--arch=x64"], {
        realOmp: true,
      }),
    );
  else
    stages.push({
      id: "centos7-local-package",
      command: "bash",
      args: ["scripts/publish/centos7/build-zip.sh"],
      packageInputs: true,
    });
  const standalone = "ompPerformanceHotPaths.components.e2e.mjs";
  stages.push(
    node("components-hotpaths", [`packages/desktop/test/${standalone}`], {
      electron: true,
      env: { OMP_COMPONENT_PHASE: "complete" },
    }),
  );
  for (const file of (await filesAt("packages/desktop/test")).filter(
    (name) => name.endsWith(".e2e.mjs") && name !== standalone,
  )) {
    if (file.startsWith("centos") && process.platform === "win32") continue;
    if (file === "centosPerformance.gui.e2e.mjs") {
      stages.push(
        node("centos-runtime-performance", [`packages/desktop/test/${file}`], { electron: true }),
      );
      continue;
    }
    const simple = [
      "ompStartup.gui.e2e.mjs",
      "ompSkills.gui.e2e.mjs",
      "ompConfirm.gui.e2e.mjs",
      "centosChineseFont.gui.e2e.mjs",
    ];
    for (const phase of guiPhases[file] ?? ["live"]) {
      stages.push(
        node(`gui:${file}:${phase}`, [`packages/desktop/test/${file}`], {
          fixture: true,
          file,
          phase,
          realOmp: !file.startsWith("centos"),
          unknownGui: !guiPhases[file] && !simple.includes(file),
          ...(file === "ompNativeCommands.gui.e2e.mjs"
            ? {
                env: {
                  OMP_NATIVE_GUI_SCENARIOS: "local,models,compact,team,plan",
                  OMP_NATIVE_GUI_RESUME: "0",
                },
              }
            : {}),
        }),
      );
    }
  }
  if (process.platform !== "win32")
    stages.push({
      id: "centos-launcher",
      command: "bash",
      args: ["scripts/publish/centos7/launch.test.sh"],
    });
  stages.push(
    node("desktop-gui-smoke", ["scripts/dev/gui-smoke-cdp.mjs"], { fixture: true, phase: "smoke" }),
  );
  return stages;
}

export const extendedStages = [
  { id: "wsl-linux", kind: "wsl" },
  ...["centos7-vm-package", "citrix-ime", "target-network-disk"].map((id) => ({ id, kind: "gap" })),
  { id: "release-windows", kind: "release", workflow: "release-windows.yml" },
  { id: "release-centos7", kind: "release", workflow: "release-centos7.yml" },
];
