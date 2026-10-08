import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

export const activeChildren = new Set();
let commandsCancelled = false;
export const elapsed = (start) => ((performance.now() - start) / 1000).toFixed(1);
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        done();
      }, 4000);
      killer.once("error", () => {
        clearTimeout(timer);
        done();
      });
      killer.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Owned tree already exited. */
    }
  }
}

export async function stopAll() {
  await Promise.all([...activeChildren].map(stopTree));
}

export function cancelCommands() {
  commandsCancelled = true;
}

export function startBudget(budget, started, onTimeout) {
  if (!Number.isFinite(budget) || budget < 5 || budget > 60)
    throw new Error("fastcheck budget must be between 5 and 60 seconds; it may only be lowered");
  return setTimeout(
    async () => {
      cancelCommands();
      await stopAll();
      await onTimeout({
        status: "TIMEOUT",
        seconds: Number(elapsed(started)),
        budgetSeconds: budget,
      });
    },
    Math.max(1, budget - 5) * 1000,
  );
}

export function startCommand(command, args = [], options = {}) {
  if (commandsCancelled) throw new Error("Gate cancelled; refusing to start another process");
  let executable = command;
  if (command === "node") executable = process.execPath;
  if (command === "pnpm") {
    const entry = process.env.npm_execpath;
    if (!entry || !/pnpm\.(?:c?js)$/u.test(entry)) {
      throw new Error("Run the gate through pnpm (npm_execpath must identify pnpm's JS entry)");
    }
    executable = process.execPath;
    args = [entry, ...args];
  }
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: withPinnedNodePath({ ...process.env, ...options.env }, process.execPath),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  return child;
}

export async function commandOutput(command, args = [], options = {}) {
  const child = startCommand(command, args, options);
  // 管道分片可截断中文 UTF-8 字节；流解码必须保留半个字符，不能逐 Buffer.toString 生成替换符。
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let diagnostics = "";
  let skipped = false;
  let tail = "";
  const collect = (data, fromStderr = false) => {
    const text = data;
    if (options.stdoutOnly && fromStderr) diagnostics += text;
    else output += text;
    if (!options.quiet) process.stdout.write(text);
    tail = (tail + text).slice(-12000);
    skipped ||= /# SKIP|(?:#|ℹ) skipped [1-9]|\[UNVERIFIED|requires .*; skipped/u.test(tail);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", (data) => collect(data, true));
  return await new Promise((done) => {
    child.once("error", (error) => {
      activeChildren.delete(child);
      done({ code: 1, output: `${output}\n${diagnostics}${error.message}`, skipped: false });
    });
    child.once("close", (code) => {
      activeChildren.delete(child);
      done({
        code: code ?? 1,
        output: code !== 0 && options.stdoutOnly ? output + diagnostics : output,
        skipped,
      });
    });
  });
}

export async function gitText(args) {
  // Git 的 LF/CRLF 诊断与 diff 跨流拼接顺序不稳定；指纹只取 stdout，失败仍保留 stderr。
  const result = await commandOutput("git", args, { quiet: true, stdoutOnly: true });
  if (result.code) throw new Error(result.output.trim());
  return result.output;
}

export async function snapshot() {
  const head = (await gitText(["rev-parse", "HEAD"])).trim();
  const diff = await gitText(["diff", "--binary", "HEAD"]);
  const untracked = (await gitText(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256").update(diff);
  for (const name of untracked) {
    hash.update(name).update(await readFile(name));
  }
  const status = (await gitText(["status", "--short"])).trim();
  return {
    head,
    contentHash: hash.digest("hex"),
    clean: !status,
    dirty: status.split("\n").filter(Boolean),
  };
}

export function sameSnapshot(a, b) {
  return a?.head === b?.head && a?.contentHash === b?.contentHash;
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
}

export async function stageResult(stage, operation) {
  const start = performance.now();
  let result;
  try {
    result = await operation();
  } catch (error) {
    result = { status: "FAIL", reason: error.message };
  }
  const record = { id: stage.id, seconds: Number(elapsed(start)), ...result };
  console.log(
    `[${record.status}] ${record.id} ${record.seconds.toFixed(1)}s${record.reason ? `: ${record.reason}` : ""}`,
  );
  return record;
}
