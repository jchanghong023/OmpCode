import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { commandOutput, windowsSystemToolPath } from "./test-gates-process.mjs";
import { bazelOutputBase, repositoryRoot, gatesInputsDir } from "./test-gates-bazel-locations.mjs";

// Bazel 可执行定位与取消路径的所属进程清理；正常入口复用 Bazel server。

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
  const version = await commandOutput(found, ["--version"], { quiet: true });
  if (version.code !== 0) {
    bazelRuntime = {
      unavailable: `bazel --version failed: ${version.output.trim().slice(0, 200)}`,
    };
    return bazelRuntime;
  }
  bazelRuntime = { path: found, version: version.output.trim() };
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

// 批客户端 java 可能脱离 bazelisk 父进程（此前崩溃/被杀的运行会遗留持有
// output_base 锁的 java）。按 --output_base 标记匹配进程命令行并整树终止，
// 只命中本门禁专属路径，不触碰其他 Bazel 工程。
export async function killByOutputBaseMarker(outputBase = bazelOutputBase) {
  if (process.platform !== "win32") {
    // 复用 Bazel 原生 PID 文件；Linux 上再核对命令行，避免旧 PID 被复用时误杀其他工程。
    try {
      const pid = Number(await readFile(join(outputBase, "server", "server.pid.txt"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (commandLine.includes(outputBase)) process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
    return;
  }
  const markerBackslash = outputBase.replaceAll("'", "''");
  const markerSlash = outputBase.split("\\").join("/").replaceAll("'", "''");
  const script =
    "$m1='" +
    markerBackslash +
    "';$m2='" +
    markerSlash +
    "';" +
    "Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like ('*'+$m1+'*') " +
    "-or $_.CommandLine -like ('*'+$m2+'*')) -and $_.ProcessId -ne $PID } | " +
    `ForEach-Object { & '${windowsSystemToolPath("taskkill.exe").replaceAll("'", "''")}' /PID $_.ProcessId /T /F | Out-Null }; exit 0`;
  const killer = spawn("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });
  return await new Promise((done) => {
    killer.once("error", () => done());
    killer.once("close", () => done());
  });
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
