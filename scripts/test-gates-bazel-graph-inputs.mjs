import { readdir } from "node:fs/promises";

// 图生成与原有产品 scope 共用排除边界；运输、诊断和产物不能成为自失效输入。
export const excludes = [
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
export const rootFiles = [
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

// 先按根分区排除整树，再交给原生 glob；所有全仓分类共用，保留点目录、未知目录和目录符号链接。
export async function repositoryGlobIncludes(workspace) {
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
  return [
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
}
