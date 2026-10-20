import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, cp, rm, utimes, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOutput, registerTreeKiller } from "./test-gates-process.mjs";
import {
  bazelRuntimeInfo,
  resolveBashSh,
  killByOutputBaseMarker,
} from "./test-gates-bazel-runtime.mjs";
import { parseBuildEventFile, actionCacheStates, isBazelCacheMiss } from "./test-gates-bep.mjs";
import { repositoryRoot } from "./test-gates-bazel-locations.mjs";

// Real Git worktrees, independent native servers and one disk cache. All child
// commands use the gate's process registry, so its global deadline owns this too.
export async function bazelSelfTest() {
  const bazel = await bazelRuntimeInfo();
  assert.ok(!bazel.unavailable, `Bazel fixture requires Bazel: ${bazel.unavailable}`);
  const root = await mkdtemp(join(tmpdir(), "ompcode-native-worktree-"));
  const first = join(root, "repo");
  const second = join(root, "worktree");
  const bases = [join(root, "base-a"), join(root, "base-b")];
  const disk = join(root, "disk-cache");
  const bash = await resolveBashSh();
  const unregister = registerTreeKiller(() =>
    Promise.all(bases.map((base) => killByOutputBaseMarker(base))),
  );
  const git = async (args, cwd = first) => {
    const result = await commandOutput("git", args, { cwd, quiet: true });
    assert.equal(result.code, 0, result.output);
  };
  let sequence = 0;
  const invoke = async (workspace, base, targets, extra = []) => {
    const bep = join(root, `events-${sequence++}.json`);
    const execution = join(root, `execution-${sequence}.json`);
    const result = await commandOutput(
      bazel.path,
      [
        "--nohome_rc",
        "--nosystem_rc",
        `--output_base=${base}`,
        targets.every((target) => target === "gate-product") ? "build" : "test",
        "--noenable_runfiles",
        "--jobs=4",
        "--local_test_jobs=4",
        "--test_output=errors",
        "--cache_test_results=auto",
        `--disk_cache=${disk}`,
        "--build_event_publish_all_actions",
        `--build_event_json_file=${bep}`,
        `--execution_log_json_file=${execution}`,
        `--define=GATES_NODE=${process.execPath}`,
        `--test_env=JCH_GATES_NODE=${process.execPath}`,
        ...extra,
        ...targets.map((target) => `//:${target}`),
      ],
      { cwd: workspace, quiet: true, env: { BAZEL_SH: bash } },
    );
    return {
      ...result,
      bepPath: bep,
      events: await parseBuildEventFile(bep, targets),
      cacheStates: await actionCacheStates(execution),
    };
  };
  const passed = (result, target) => {
    assert.equal(result.events.get(target)?.status, "PASSED", result.output);
    assert.equal(result.events.get(target)?.complete, true);
  };
  const targetList = ["gate-one", "gate-two", "gate-unrelated"];
  let succeeded = false;
  try {
    await mkdir(join(first, "scripts"), { recursive: true });
    await mkdir(join(first, "gates"), { recursive: true });
    await mkdir(join(first, "gates/inputs"), { recursive: true });
    for (const file of [
      "test-gates-action.mjs",
      "test-gates-bazel-runtime.mjs",
      "test-gates-bazel-locations.mjs",
      "test-gates-process.mjs",
      "test-gates-watchdog.mjs",
      "test-gates-clock.mjs",
      "test-gates-test-reporter.mjs",
      "mise-toolchain-env.mjs",
      "spawn-command.mjs",
    ])
      await cp(join(repositoryRoot, "scripts", file), join(first, "scripts", file));
    const buildStage = {
      id: "product",
      kind: "compile",
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs');fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/product.txt',fs.readFileSync('shared.txt'));",
      ],
      outputs: ["build/product.txt"],
    };
    await writeFile(
      join(first, "gates/inputs/gate-product.json"),
      JSON.stringify({ stage: buildStage, env: {} }),
    );
    await cp(join(repositoryRoot, "gates/rules.bzl"), join(first, "gates/rules.bzl"));
    await writeFile(
      join(first, "MODULE.bazel"),
      'module(name = "gate_fixture")\nbazel_dep(name = "rules_shell", version = "0.6.1")\n',
    );
    await cp(join(repositoryRoot, ".bazelversion"), join(first, ".bazelversion"));
    await writeFile(join(first, "shared.txt"), "shared-v1");
    await writeFile(join(first, "unrelated.txt"), "unrelated-v1");
    await writeFile(join(first, "broken.txt"), "fail");
    await writeFile(
      join(first, "scripts/test-gates-bazel-exec.mjs"),
      `import {realpathSync,appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url'; import {dirname,join} from 'node:path';
const root=dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const target=process.argv.at(-1);const record=(event)=>appendFileSync(join(root,'execution.jsonl'),JSON.stringify({target,event,time:Date.now()})+'\\n');
record('start');
if(target==='gate-broken'){ const mode=readFileSync(join(root,'broken.txt'),'utf8'); console.error('fixture failure log '+mode); if(mode==='hang') await new Promise(()=>{setInterval(()=>{},1000)}); if(mode==='skip') console.log('# SKIP fixture unverified'); process.exit(1); }
await new Promise(resolve=>setTimeout(resolve,700));record('end');console.log('fixture native log '+target);
`,
    );
    const common = '["scripts/test-gates-bazel-exec.mjs"]';
    const build = [
      'load("//:gates/rules.bzl", "gate_test", "gate_action")',
      ...[...targetList, "gate-broken"].map(
        (target) =>
          `gate_test(name="${target}",stage="${target}",size="small",data=${common}+["${target === "gate-unrelated" ? "unrelated.txt" : target === "gate-broken" ? "broken.txt" : "shared.txt"}"])`,
      ),
      `gate_test(name="gate-required",stage="gate-required",size="small",tags=["no-cache"],data=${common})`,
      'gate_action(name="gate-product",stage="gate-product",data=glob(["scripts/**"])+["shared.txt","gates/inputs/gate-product.json"])',
    ];
    await writeFile(join(first, "BUILD.bazel"), build.join("\n"));
    await git(["init", "--initial-branch=fixture"]);
    await git(["config", "core.autocrlf", "false"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Native Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "native fixture",
    ]);
    await git(["worktree", "add", "--detach", second, "HEAD"]);
    for (const workspace of [first, second])
      await writeFile(
        join(workspace, "gates/inputs/runtime.json"),
        JSON.stringify({ env: process.env }),
      );
    const firstBuild = await invoke(first, bases[0], ["gate-product"]);
    assert.equal(firstBuild.code, 0, firstBuild.output);
    assert.equal(
      await readFile(
        join(first, "bazel-bin/gates/artifacts/gate-product/build/product.txt"),
        "utf8",
      ),
      "shared-v1",
      "cold build must capture its declared artifact",
    );
    const materialize = async (workspace) => {
      await writeFile(
        join(workspace, "fixture-materialize.mjs"),
        `import {materializeStageArtifacts} from './scripts/test-gates-action.mjs';await materializeStageArtifacts(${JSON.stringify(buildStage)},${JSON.stringify(join(workspace, "bazel-bin"))});`,
      );
      const restored = await commandOutput(process.execPath, ["fixture-materialize.mjs"], {
        cwd: workspace,
        quiet: true,
      });
      assert.equal(restored.code, 0, restored.output);
      assert.equal(await readFile(join(workspace, "build/product.txt"), "utf8"), "shared-v1");
      if (process.platform === "win32") {
        // 保留 size/mtime，只改属性和 change-time，重现 Robocopy 漏掉 Modified 文件的条件。
        await chmod(join(workspace, "build/product.txt"), 0o444);
        const refreshed = await commandOutput(process.execPath, ["fixture-materialize.mjs"], {
          cwd: workspace,
          quiet: true,
        });
        assert.equal(refreshed.code, 0, refreshed.output);
      }
      // 工作副本必须可供后续构建覆盖；不能继承缓存的只读属性或与缓存共用可变文件。
      await writeFile(join(workspace, "build/product.txt"), "consumer-overwrite");
      assert.equal(
        await readFile(join(workspace, "build/product.txt"), "utf8"),
        "consumer-overwrite",
      );
    };
    await materialize(first);
    const crossBuild = await invoke(second, bases[1], ["gate-product"]);
    assert.equal(crossBuild.code, 0, crossBuild.output);
    assert.equal(
      crossBuild.cacheStates?.get("gate-product"),
      "diskCache",
      "official execution log must prove cross-worktree disk cache hit",
    );
    assert.equal(
      await readFile(
        join(second, "bazel-bin/gates/artifacts/gate-product/build/product.txt"),
        "utf8",
      ),
      "shared-v1",
      "disk cache must restore the declared artifact tree",
    );
    await materialize(second);
    // materialize() 末尾有意验证消费者覆盖写；必须再次回填后才断言缓存恢复，
    // 不能把仍处于 consumer-overwrite 的工作副本误判成缓存产物损坏。
    const restoredCached = await commandOutput(process.execPath, ["fixture-materialize.mjs"], {
      cwd: second,
      quiet: true,
    });
    assert.equal(restoredCached.code, 0, restoredCached.output);
    assert.equal(
      await readFile(join(second, "build/product.txt"), "utf8"),
      "shared-v1",
      "cached declared tree must restore real build product",
    );
    // 冷查询必须只报告需要执行，不能越过风险屏障执行任何测试。
    const coldProbe = await invoke(first, bases[0], targetList, ["--check_tests_up_to_date"]);
    assert.equal(await isBazelCacheMiss(coldProbe.bepPath, coldProbe.code), true, coldProbe.output);
    await assert.rejects(readFile(join(first, "execution.jsonl")), { code: "ENOENT" });
    const cold = await invoke(first, bases[0], targetList);
    assert.equal(cold.code, 0, cold.output);
    for (const target of targetList) {
      passed(cold, target);
      assert.equal(cold.events.get(target).cached, false);
    }
    const timeline = (await readFile(join(first, "execution.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const starts = timeline.filter((event) => event.event === "start");
    const ends = timeline.filter((event) => event.event === "end");
    assert.ok(
      Math.max(...starts.map((event) => event.time)) < Math.min(...ends.map((event) => event.time)),
      "native jobs must overlap",
    );
    assert.ok(cold.events.get("gate-one").logPath, "BEP must locate the native test log");
    const shared = await invoke(second, bases[1], targetList);
    assert.equal(shared.code, 0, shared.output);
    for (const target of targetList) {
      passed(shared, target);
      assert.equal(shared.events.get(target).cached, true, `cross-worktree disk hit ${target}`);
    }
    const beforeProbe = await readFile(join(second, "execution.jsonl"), "utf8").catch(() => "");
    const warmProbe = await invoke(
      second,
      bases[1],
      [...targetList, "gate-product"],
      ["--check_tests_up_to_date"],
    );
    assert.equal(warmProbe.code, 0, warmProbe.output);
    for (const target of targetList) {
      passed(warmProbe, target);
      assert.equal(warmProbe.events.get(target).cached, true, `cache-only ${target}`);
    }
    assert.equal(warmProbe.events.get("gate-product")?.status, "PASSED");
    assert.equal(
      await readFile(join(second, "execution.jsonl"), "utf8").catch(() => ""),
      beforeProbe,
      "cache-only validation must not execute tests",
    );
    const invalidProbe = await invoke(second, bases[1], targetList, [
      "--check_tests_up_to_date",
      "--gate_fixture_invalid_option",
    ]);
    assert.notEqual(invalidProbe.code, 0);
    assert.equal(
      await isBazelCacheMiss(invalidProbe.bepPath, invalidProbe.code),
      false,
      "query errors must not enter the cache-miss execution path",
    );
    const now = new Date(Date.now() + 10000);
    await utimes(join(second, "shared.txt"), now, now);
    const mtime = await invoke(second, bases[1], targetList);
    for (const target of targetList)
      assert.equal(mtime.events.get(target)?.cached, true, `mtime-only ${target}`);
    // 缓存 miss 会直接重跑生产者；工作区旧只读产物不能使真实写入报 EPERM。
    await chmod(join(second, "build/product.txt"), 0o444);
    await writeFile(join(second, "shared.txt"), "shared-v2");
    const staleProbe = await invoke(second, bases[1], targetList, ["--check_tests_up_to_date"]);
    assert.equal(
      await isBazelCacheMiss(staleProbe.bepPath, staleProbe.code),
      true,
      staleProbe.output,
    );
    assert.equal(
      await readFile(join(second, "execution.jsonl"), "utf8").catch(() => ""),
      beforeProbe,
      "invalidated cache query must not execute a test",
    );
    const changed = await invoke(second, bases[1], targetList);
    for (const target of ["gate-one", "gate-two"]) {
      passed(changed, target);
      assert.equal(changed.events.get(target).cached, false, `shared invalidation ${target}`);
    }
    assert.equal(
      changed.events.get("gate-unrelated")?.cached,
      true,
      "unrelated scope must remain cached",
    );
    const rebuilt = await invoke(second, bases[1], ["gate-product"]);
    assert.equal(rebuilt.code, 0, rebuilt.output);
    assert.equal(rebuilt.cacheStates?.get("gate-product"), "new");
    assert.equal(
      await readFile(join(second, "build/product.txt"), "utf8"),
      "shared-v2",
      "producer cache miss must replace a readonly workspace output",
    );
    for (let run = 0; run < 2; run++) {
      const required = await invoke(second, bases[1], ["gate-required"]);
      assert.equal(required.code, 0, required.output);
      passed(required, "gate-required");
      assert.equal(
        required.events.get("gate-required").cached,
        false,
        "mandatory no-cache preparation must execute on every invocation",
      );
    }
    for (const mode of ["fail", "skip", "hang"]) {
      await writeFile(join(second, "broken.txt"), mode);
      for (let attempt = 0; attempt < 2; attempt++) {
        const failure = await invoke(second, bases[1], ["gate-broken"], ["--test_timeout=2"]);
        assert.notEqual(failure.code, 0, `${mode} must not pass`);
        assert.notEqual(failure.events.get("gate-broken")?.status, "PASSED");
        assert.equal(failure.events.get("gate-broken")?.cached, false, `${mode} cannot cache PASS`);
      }
    }
    const empty = await parseBuildEventFile(join(root, "missing-events.json"), ["gate-broken"]);
    assert.equal(empty.has("gate-broken"), false, "incomplete BEP cannot manufacture PASS");
    console.log(
      "[PASS] native Git worktree disk-cache/mtime/dependency/failure/skip/timeout/concurrency/log fixtures",
    );
    succeeded = true;
  } catch (error) {
    throw new Error(`${error.stack ?? error}\nNative fixture evidence retained: ${root}`, {
      cause: error,
    });
  } finally {
    // Deadline cleanup owns both server bases, even when cancellation prevents
    // finally from admitting another registered command.
    for (const base of bases)
      await commandOutput(
        bazel.path,
        ["--nohome_rc", "--nosystem_rc", `--output_base=${base}`, "shutdown"],
        { cwd: first, quiet: true, env: { BAZEL_SH: bash } },
      ).catch(() => {});
    await Promise.all(bases.map((base) => killByOutputBaseMarker(base)));
    unregister();
    for (const workspace of [first, second])
      await rm(join(workspace, "gates/inputs/runtime.json"), { force: true });
    if (succeeded) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
