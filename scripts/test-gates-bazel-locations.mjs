import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// 门禁 Bazel 桥接的路径常量，供桥接与运行时模块共用。
export const repositoryRoot = resolve(realpathSync(fileURLToPath(import.meta.url)), "..", "..");
export const gatesInputsDir = resolve(repositoryRoot, "gates", "inputs");
export const gatesToolchainFile = resolve(repositoryRoot, "gates", "toolchain.json");
// A server/output lock belongs to one worktree; only Bazel's disk cache is shared.
const cacheRoot = join(process.env.LOCALAPPDATA ?? homedir(), "zcode-gates-bazel");
export const bazelOutputBase = join(
  cacheRoot,
  "worktrees",
  createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 20),
);
export const bazelDiskCache = join(cacheRoot, "disk-cache");
