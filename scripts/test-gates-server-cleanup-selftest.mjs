import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commandOutput, startCommand, stopCommand } from "./test-gates-process.mjs";
import { parseBuildEventFile } from "./test-gates-bep.mjs";

const pidFile = (base) => join(base, "server/server.pid.txt");
const readPid = async (base) => {
  const pid = Number(await readFile(pidFile(base), "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `native server PID: ${base}`);
  return pid;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function cleanupFailureSelfTest() {
  // cancelCommands 是单向状态；在真实子进程中注册失败清理器，不能污染后续原生 fixture。
  const result = await commandOutput(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import { registerTreeKiller, cancelCommands, stopAll } from ${JSON.stringify(new URL("./test-gates-process.mjs", import.meta.url).href)};
const failure = new Error("fixture-owned-worker-cleanup-failure");
const settled = [];
registerTreeKiller(async () => { settled.push("rejected"); throw failure; });
registerTreeKiller(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  settled.push("completed");
});
cancelCommands();
await assert.rejects(stopAll(), (error) => {
  assert.strictEqual(error, failure, "stopAll must propagate the original cleanup error");
  assert.deepEqual(settled, ["rejected", "completed"], "stopAll must await every admitted cleaner");
  return true;
});
console.log("fixture-cleanup-rejection-propagated");
`,
    ],
    { quiet: true },
  );
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /fixture-cleanup-rejection-propagated/u);
}

export async function serverLifecycleSelfTest({
  bazel,
  first,
  second,
  bases,
  bash,
  startupArgs,
  disk,
}) {
  await cleanupFailureSelfTest();
  const root = dirname(first);
  const info = async (workspace, base) => {
    const result = await commandOutput(
      bazel.path,
      [...startupArgs, `--output_base=${base}`, "info", "server_pid"],
      { cwd: workspace, quiet: true, bazel: true, env: { BAZEL_SH: bash } },
    );
    assert.equal(result.code, 0, result.output);
    const pids = result.output.split(/\r?\n/u).filter((line) => /^\d+$/u.test(line.trim()));
    assert.equal(pids.length, 1, `Bazel info must report one server PID: ${result.output}`);
    return Number(pids[0]);
  };
  const firstPid = await info(first, bases[0]);
  const secondPid = await info(second, bases[1]);
  assert.equal(await readPid(bases[0]), firstPid);
  assert.equal(await readPid(bases[1]), secondPid);
  // 哨兵命令行故意带完整 marker 和验收脚本路径；它不是本次调用的 worker，不能被清理。
  const sentinel = startCommand(
    process.execPath,
    [
      "-e",
      "setInterval(()=>{},1000);console.log('sentinel-ready')",
      "--",
      `--output_base=${bases[0]}`,
      join(bases[0], "diagnostics/acceptance-orchestrator.mjs"),
    ],
    { quiet: true },
  );
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      sentinel.stdout.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (output.includes("sentinel-ready")) resolve();
      });
      sentinel.once("error", reject);
      sentinel.once("close", (code) =>
        reject(new Error(`sentinel exited before lifecycle assertions: ${code}`)),
      );
    });
    // 原生 PID watcher 会因文件消失主动停机；取消验收不能破坏 Bazel 自有元数据。
    for (const mode of ["success", "failure", "timeout", "cancel"]) {
      const receipt = join(root, `lifecycle-${mode}.worker.json`);
      const bep = join(root, `lifecycle-${mode}.bep.json`);
      const args = [
        ...startupArgs,
        `--output_base=${bases[0]}`,
        "test",
        "--noenable_runfiles",
        "--cache_test_results=no",
        "--test_output=errors",
        // 原因：超时模式曾用 2 秒（后曾提到 10 秒）时限；fulltest 高负载下 fixture 日志实测
        // bash runner 从 shell-start 到 shell-ready 即需约 6 秒，Node worker 在写准入收据前
        // 就被原生超时回收，收据 ENOENT 使自检间歇失败。依据：worker 写收据后立即永久挂起，
        // 时限只决定何时被原生超时终止；统一 30 秒仍保持“真实超时终止 worker、server 存活”
        // 的原生语义，不放宽任何回收或复用断言。
        "--test_timeout=30",
        `--disk_cache=${disk}`,
        `--build_event_json_file=${bep}`,
        `--define=GATES_NODE=${process.execPath}`,
        `--test_env=JCH_GATES_NODE=${process.execPath}`,
        `--test_env=GATE_LIFECYCLE_MODE=${mode}`,
        `--test_env=GATE_LIFECYCLE_RECEIPT=${receipt}`,
        "//:gate-lifecycle",
      ];
      // 取消状态不能泄漏到主 fixture；真实客户端关闭后，仍须等原生 worker 被回收。
      const result = await commandOutput(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commandOutput, cancelCommands, stopAll } from ${JSON.stringify(new URL("./test-gates-process.mjs", import.meta.url).href)};
const mode = ${JSON.stringify(mode)};
let completed = false;
const running = commandOutput(${JSON.stringify(bazel.path)}, ${JSON.stringify(args)}, {
  cwd: ${JSON.stringify(first)}, quiet: true, bazel: true, env: { BAZEL_SH: ${JSON.stringify(bash)} },
}).then(result => { completed = true; return result; });
try {
  if (mode === "cancel") {
    const deadline = Date.now() + 30000;
    while (true) {
      const receipt = await readFile(${JSON.stringify(receipt)}, "utf8").catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (receipt) break;
      assert.equal(completed, false, "native client must admit a real worker before cancellation");
      assert.ok(Date.now() < deadline, "native worker admission deadline");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    cancelCommands();
    await stopAll();
  }
  const result = await running;
  if (mode === "success") assert.equal(result.code, 0, result.output);
  else assert.notEqual(result.code, 0, mode + " must not pass: " + result.output);
  console.log("fixture-lifecycle-" + mode);
} finally {
  await stopAll();
}
`,
        ],
        { quiet: true },
      );
      assert.equal(result.code, 0, result.output);
      assert.ok(result.output.includes(`fixture-lifecycle-${mode}`), result.output);
      const worker = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(worker.mode, mode);
      assert.ok(Number.isSafeInteger(worker.pid) && worker.pid > 1, "real native worker PID");
      const deadline = Date.now() + 10000;
      while (alive(worker.pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(alive(worker.pid), false, `${mode} must reclaim its real native worker`);
      if (["success", "failure", "timeout"].includes(mode)) {
        const events = await parseBuildEventFile(bep, ["gate-lifecycle"]);
        assert.equal(events.get("gate-lifecycle")?.complete, true, `${mode} complete BEP`);
        assert.equal(
          events.get("gate-lifecycle")?.status,
          mode === "success" ? "PASSED" : mode === "timeout" ? "TIMEOUT" : "FAILED",
          `${mode} native result`,
        );
        assert.equal(events.get("gate-lifecycle")?.cached, false, `${mode} must execute`);
      }
      assert.equal(alive(firstPid), true, `${mode} must preserve this worktree server`);
      assert.equal(alive(secondPid), true, `${mode} must preserve the other worktree server`);
      assert.equal(alive(sentinel.pid), true, `${mode} must preserve marker-bearing Node sentinel`);
      assert.equal(await readPid(bases[0]), firstPid, `${mode} must retain the native PID file`);
      assert.equal(
        await info(first, bases[0]),
        firstPid,
        `${mode} must reuse this worktree server`,
      );
      assert.equal(await info(second, bases[1]), secondPid, `${mode} must reuse the other server`);
      await rm(receipt, { force: true });
    }
    console.log(
      "[PASS] native server reuse after success/failure/timeout/cancel; worker/sentinel/worktree isolation",
    );
  } finally {
    // 只收回本 fixture 注册的哨兵；输出根与两个原生 server 继续交给 Bazel 管理。
    await stopCommand(sentinel);
  }
}
