import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // Windows runner 上 bare `pnpm` / `npm` 实际也是通过 cmd shim 提供。
      // 之前先把命令名改写成 `pnpm.cmd`，会让部分 `pnpm exec` 场景重新落回错误的包 cwd，
      // 最终把 tsup 入口解析成 scripts/src/... 并报“Cannot find src/main/index.ts”。
      // 这里保留原始命令名，只要求 shell/cmd.exe 负责解析 shim，避免再次改变 pnpm 的包上下文。
      shell: true,
    };
  }

  return {};
}

// shell:true 时 Node 只把 args 按空格拼接进命令行、不做转义（对应 DEP0190 警告）。
// Windows 的路径空格和 grep 正则中的括号、重定向等字符都必须作为字面参数传递。
// 引号前的尾部反斜杠需加倍，避免子进程 argv 解析器把结束引号当作字面字符。
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) =>
    arg === "" || /[\s&|<>^()*]/u.test(arg)
      ? `"${arg.replace(/\\+$/u, (slashes) => slashes + slashes)}"`
      : arg,
  );
}

export function runCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    stdio: "inherit",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    encoding: "utf8",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
