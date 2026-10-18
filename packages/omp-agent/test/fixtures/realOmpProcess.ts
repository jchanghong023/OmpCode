import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRealOmpEnvironment } from "./realOmpEnvironment.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

// 真实 read 先完成，屏障只推迟其回调交付；没有伪造文件内容、进程或协议帧。
const sessionReadBarrierPreload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const actualCreateReadStream = fs.createReadStream;
let armed;
let release;
process.on("message", message => {
  if (message?.kind === "session-read-arm") {
    armed = message;
    process.send({ kind: "session-read-armed", token: message.token });
  } else if (message?.kind === "session-read-release") {
    release?.();
  }
});
process.on("disconnect", () => release?.());
process.channel?.unref();
fs.createReadStream = function(path, options) {
  if (!armed || !basename(String(path)).endsWith("_" + armed.sessionId + ".jsonl"))
    return actualCreateReadStream(path, options);
  const barrier = armed;
  armed = undefined;
  let paused = false;
  return actualCreateReadStream(path, {
    ...(typeof options === "string" ? { encoding: options } : options),
    fs: {
      ...fs,
      read(fd, buffer, offset, length, position, callback) {
        fs.read(fd, buffer, offset, length, position, (error, bytesRead, result) => {
          if (paused || error) return callback(error, bytesRead, result);
          paused = true;
          release = () => {
            release = undefined;
            callback(error, bytesRead, result);
          };
          process.send({ kind: "session-read-reached", token: barrier.token });
        });
      },
    },
  });
};
syncBuiltinESMExports();
`;

interface RealOmpLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function createRealOmpLaunch(
  options: { workspace: string; home: string; configRoot: string; ompBinary: string },
  sessionReadBarrier = false,
): RealOmpLaunch {
  return {
    command: process.execPath,
    args: [
      "--import",
      tsxLoader,
      ...(sessionReadBarrier
        ? ["--import", `data:text/javascript,${encodeURIComponent(sessionReadBarrierPreload)}`]
        : []),
      adapterEntry,
      "app-server",
      "--stdio",
    ],
    cwd: options.workspace,
    env: createRealOmpEnvironment(process.env, options),
  };
}

export function spawnRealOmpProcess(
  launch: RealOmpLaunch,
  sessionReadBarrier = false,
): ChildProcessWithoutNullStreams {
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: sessionReadBarrier ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
}

export async function closeRealOmpProcess(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  // 正常 EOF 让 OMP dispose 并释放 SQLite，再删除隔离根；异常挂起才回收所属树。
  child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    closed.then(() => true),
    new Promise<false>((done) => {
      timer = setTimeout(() => done(false), 10000);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
  if (!exited && child.pid !== undefined) {
    if (process.platform === "win32") {
      await new Promise<void>((done, reject) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", reject);
        killer.once("exit", () => done());
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await closed;
  }
}
