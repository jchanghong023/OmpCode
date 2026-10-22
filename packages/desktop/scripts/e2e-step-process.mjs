import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";
import {
  quoteArgsForWindowsShell,
  resolveSpawnRuntimeOptions,
} from "../../../scripts/spawn-command.mjs";
import { terminateOwnedE2EProcesses } from "../test/e2e/helpers/e2e-process-cleanup.ts";

function formatStepError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createStepStartFailure(error) {
  return { exitCode: 1, error: formatStepError(error) };
}

function normalizeStepExecution(value) {
  if (value && typeof value === "object" && "result" in value) {
    return {
      result: Promise.resolve(value.result),
      terminate: typeof value.terminate === "function" ? () => value.terminate() : undefined,
    };
  }
  return { result: Promise.resolve(value), terminate: undefined };
}

function normalizeStepResult(result) {
  if (!result || typeof result !== "object") {
    return createStepStartFailure(new Error("step returned no result"));
  }
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
    ...(result.signal ? { signal: String(result.signal) } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
  };
}

export function startStepExecution(runStep, step) {
  let execution;
  try {
    execution = normalizeStepExecution(runStep(step));
  } catch (error) {
    execution = normalizeStepExecution(createStepStartFailure(error));
  }
  return {
    result: execution.result.then(normalizeStepResult, (error) => createStepStartFailure(error)),
    terminate: execution.terminate,
  };
}

export function spawnCancellableStep(step) {
  let child;
  const failurePrefix = step.env?.ZCODE_E2E_FAIL_FAST_PREFIX;
  const parseFailures = Boolean(failurePrefix && typeof step.onFailure === "function");
  let failureReported = false;
  const notifyFailure = (payload) => {
    if (failureReported) return;
    failureReported = true;
    step.onFailure(payload);
  };
  try {
    const runtimeOptions = resolveSpawnRuntimeOptions(step.command);
    const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(step.args) : step.args;
    child = spawn(step.command, spawnArgs, {
      cwd: step.cwd,
      env: step.env,
      stdio: parseFailures ? ["inherit", "pipe", "pipe"] : "inherit",
      // 独立进程组限定本轮所有权，取消 pnpm 时也回收 WDIO/Electron 后代。
      detached: process.platform !== "win32",
      ...runtimeOptions,
    });
  } catch (error) {
    return {
      result: Promise.resolve(createStepStartFailure(error)),
      terminate() {},
    };
  }

  if (parseFailures) {
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const consume = (text) => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/u, "");
          pending = pending.slice(newline + 1);
          // WDIO 会在原始通知前添加 [worker-id]；随机 invocation token 才是帧边界。
          const prefixIndex = line.indexOf(failurePrefix);
          if (prefixIndex < 0) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(prefixIndex + failurePrefix.length));
          } catch {
            continue;
          }
          if (
            payload &&
            ["test", "hook", "runner", "prepare"].includes(payload.kind) &&
            typeof payload.title === "string" &&
            typeof payload.error === "string" &&
            (payload.cid === undefined || typeof payload.cid === "string")
          ) {
            notifyFailure(payload);
          }
        }
      };
      stream.on("data", (chunk) => {
        destination.write(chunk);
        consume(decoder.write(chunk));
      });
      stream.on("end", () => consume(`${decoder.end()}\n`));
    }
    // exit 早于 stdio close；后代仍持有管道时也必须立即通知父 runner。
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) return;
      notifyFailure({
        kind: step.kind === "build" ? "prepare" : "runner",
        title: step.shardId ? `shard ${step.shardId}` : (step.id ?? step.command),
        error: signal ? `terminated by signal ${signal}` : `exited with code ${code ?? 1}`,
      });
    });
  }

  let termination;
  const result = new Promise((resolveRun) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      // close/error 是本轮等待的唯一进程屏障，不等待诊断与报告收尾。
      resolveRun(value);
    };

    // 修复原因：spawn 的 error 过去会 reject Promise.all，导致其他 shard 未等待、manifest 未写入。
    child.once("error", (error) => settle(createStepStartFailure(error)));
    child.once("close", (code, signal) => {
      // close 只表示 wrapper 和 stdio 已退出，不能据此放弃身份清理。
      settle({ exitCode: code ?? 1, signal: signal ?? undefined });
    });
  });

  return {
    result,
    terminate() {
      if (termination) return termination;
      const homeDir = step.env?.ZCODE_E2E_HOME_DIR?.trim();
      // wrapper close 不是后代退出屏障；utility Host/native 可先成为孤儿。
      // 按当前 shard 的独占 HOME/--cwd 补扫，不能只向已退出的 pnpm PID 发 taskkill。
      termination =
        homeDir && process.platform === "win32"
          ? terminateOwnedE2EProcesses({
              homeDir,
              runId: step.env?.ZCODE_E2E_RUN_ID,
              ...(step.kind === "child" && step.env?.ZCODE_E2E_RUN_ID
                ? {
                    chromiumProfileRootDir: join(
                      step.cwd,
                      ".e2e-cache",
                      step.env.ZCODE_E2E_RUN_ID,
                      "chromium-profiles",
                    ),
                  }
                : {}),
            })
          : Promise.resolve();
      if (!child.pid) return termination;
      if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) {
        return termination;
      }
      if (process.platform === "win32") {
        // pnpm 下还有 WDIO/Electron 等后代进程，Windows 必须按进程树强制终止。
        const killChildFallback = () => {
          try {
            child.kill();
          } catch {
            // 原进程可能已在 taskkill 启动失败前退出。
          }
        };
        let taskkill;
        try {
          taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          killChildFallback();
          return termination;
        }
        taskkill.once("error", killChildFallback);
        taskkill.once("close", (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            killChildFallback();
          }
        });
        return termination;
      }

      try {
        // 对独占组直接强退，不能让 pnpm 先退出后把仍运行的 worker 留给其他会话。
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 已退出的组无需再处理；close/error 负责产生最终结果。
      }
      return termination;
    },
  };
}
