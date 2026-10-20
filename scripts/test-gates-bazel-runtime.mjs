import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { join, dirname, delimiter, basename } from "node:path";
import { homedir } from "node:os";
import { commandOutput } from "./test-gates-process.mjs";
import { repositoryRoot, gatesInputsDir } from "./test-gates-bazel-locations.mjs";

// Bazel 可执行定位与动作环境；server 和缓存生命周期始终归 Bazel 所有。

let bazelRuntime;
export async function bazelRuntimeInfo() {
  if (bazelRuntime) return bazelRuntime;
  const candidates = [];
  if (process.env.GATES_BAZEL_BIN?.trim()) candidates.push(process.env.GATES_BAZEL_BIN.trim());
  for (const name of process.platform === "win32"
    ? ["bazelisk.exe", "bazel.exe"]
    : ["bazelisk", "bazel"])
    for (const directory of (process.env.PATH ?? "").split(delimiter))
      if (directory) candidates.push(join(directory, name));
  candidates.push(
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
      "Microsoft/WinGet/Links/bazelisk.exe",
    ),
  );
  let found;
  for (const candidate of candidates)
    try {
      await access(candidate);
      found = candidate;
      break;
    } catch {
      // 继续尝试下一个候选位置
    }
  if (!found) {
    bazelRuntime = {
      unavailable: "no bazelisk/bazel executable on PATH, GATES_BAZEL_BIN, or WinGet links",
    };
    return bazelRuntime;
  }
  const binaryContent = createHash("sha256")
    .update(await readFile(found))
    .digest("hex");
  // 默认 Windows/Bazelisk 固定版本已安装时，只读真实二进制身份，不为显示标签再启动一次客户端。
  // 显式工具、环境覆盖或本地配置仍走原有精确探测；实际执行始终保留原 launcher 的选择语义。
  let installedPin =
    process.platform === "win32" &&
    basename(found).toLowerCase() === "bazelisk.exe" &&
    !process.env.GATES_BAZEL_BIN?.trim() &&
    !Object.keys(process.env).some((key) =>
      /^(?:BAZELISK_|USE_BAZEL_VERSION$|BAZEL_REAL$)/iu.test(key),
    );
  if (installedPin)
    for (const file of [
      join(repositoryRoot, ".bazeliskrc"),
      join(homedir(), ".bazeliskrc"),
      join(repositoryRoot, "tools/bazel"),
      join(repositoryRoot, "tools/bazel.bat"),
      join(repositoryRoot, "tools/bazel.ps1"),
    ]) {
      try {
        await access(file);
        installedPin = false;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  if (installedPin) {
    try {
      const pin = (await readFile(join(repositoryRoot, ".bazelversion"), "utf8")).trim();
      if (/^\d+\.\d+\.\d+$/u.test(pin) && process.arch === "x64") {
        const downloads = join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
          "bazelisk/downloads",
        );
        const installedDigest = (
          await readFile(
            join(downloads, "metadata/bazelbuild", `bazel-${pin}-windows-x86_64`),
            "utf8",
          )
        ).trim();
        if (/^[a-f0-9]{64}$/u.test(installedDigest)) {
          const installedBinary = join(downloads, "sha256", installedDigest, "bin/bazel.exe");
          const installedContent = createHash("sha256")
            .update(await readFile(installedBinary))
            .digest("hex");
          bazelRuntime = {
            path: found,
            version: `unobserved (installed pin ${pin}; see invocation BEP)`,
            installedPin: pin,
            identity: { binaryContent, installedContent },
          };
          return bazelRuntime;
        }
      }
    } catch (error) {
      // 缺少安装证据不等于工具不可用；保留原探测和 Bazelisk 行为，不用元数据推断成功。
      if (error.code !== "ENOENT") throw error;
    }
  }
  const version = await commandOutput(found, ["--version"], { quiet: true });
  if (version.code !== 0) {
    bazelRuntime = {
      unavailable: `bazel --version failed: ${version.output.trim().slice(0, 200)}`,
    };
    return bazelRuntime;
  }
  bazelRuntime = {
    path: found,
    version: version.output.trim(),
    identity: { binaryContent, version: version.output.trim() },
  };
  return bazelRuntime;
}

export async function assertBazelReady() {
  const info = await bazelRuntimeInfo();
  if (info.unavailable)
    throw new Error(
      `Bazel is required for the three-level gates (${info.unavailable}); ` +
        "install Bazelisk (winget install Bazel.Bazelisk) or point GATES_BAZEL_BIN at bazelisk/bazel",
    );
  return info;
}

export async function resolveBashSh() {
  if (process.platform !== "win32") return process.env.BAZEL_SH || "/bin/bash";
  const candidates = [
    process.env.BAZEL_SH,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const candidate of candidates)
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续尝试下一个候选位置
    }
  throw new Error("GateTestLauncher (run_shell) requires Git Bash (set BAZEL_SH)");
}

// 准备成功之前 path.txt/dist 可以不存在；只在共享准备完成后读取真实内容身份。
export async function readElectronRuntimeIdentity() {
  const require = createRequire(join(repositoryRoot, "packages/desktop/package.json"));
  const packageFile = require.resolve("electron/package.json");
  const directory = dirname(packageFile);
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  const executable = (await readFile(join(directory, "path.txt"), "utf8")).trim();
  return {
    version: manifest.version,
    content: createHash("sha256")
      .update(await readFile(join(directory, "dist", executable)))
      .digest("hex"),
  };
}

// Host paths and isolated HOME are runtime transport, never action identity.
// Semantic values are declared in each target's control input by the bridge.
export async function prepareBazelEnvironment(stage, control) {
  const runtime = JSON.parse(await readFile(join(gatesInputsDir, "runtime.json"), "utf8"));
  Object.assign(process.env, runtime.env);
  const workspace = runtime.workspace ?? repositoryRoot;
  process.chdir(workspace);
  const expand = (value) =>
    typeof value === "string" ? value.replaceAll("${WORKSPACE}", workspace) : value;
  const env = Object.fromEntries(
    Object.entries({ ...control.env, ...stage.env }).map(([key, value]) => [key, expand(value)]),
  );
  // 测试门禁隔离宿主 provider；普通 workspace build 保留原有显式构建配置语义。
  if (!/^(?:build|bootstrap):/u.test(stage.id))
    for (const key of Object.keys(process.env))
      if (/^ZCODE_(?:BUILTIN|PERSONAL)_PROVIDER_CONFIG_FILE$/iu.test(key)) {
        delete process.env[key];
        delete env[key];
      }
  Object.assign(process.env, env);
  return { workspace, env, omp: runtime.omp };
}
