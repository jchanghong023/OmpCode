import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, cp, rm, utimes, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandOutput } from "./test-gates-process.mjs";
import { bazelRuntimeInfo, resolveBashSh } from "./test-gates-bazel-runtime.mjs";
import { parseBuildEventFile, actionCacheStates, isBazelCacheMiss } from "./test-gates-bep.mjs";
import { repositoryRoot } from "./test-gates-bazel-locations.mjs";
import { staticModuleInputs } from "./test-gates-static-modules.mjs";
import { artifactIOSelfTest } from "./test-gates-artifacts-selftest.mjs";
import { serverLifecycleSelfTest } from "./test-gates-server-cleanup-selftest.mjs";

// Real Git worktrees, independent native servers and one disk cache. All child
// commands use the gate's process registry, so its global deadline owns this too.
export async function bazelSelfTest() {
  const bazel = await bazelRuntimeInfo();
  assert.ok(!bazel.unavailable, `Bazel fixture requires Bazel: ${bazel.unavailable}`);
  // TEST_TMPDIR 下原生默认仅空闲 15 秒；复用断言期间不能因自然空闲退出而换 PID。
  // 只延长原生空闲寿命，不缩短或替代门禁总截止，也不在收尾关闭 server。
  const startupArgs = ["--nohome_rc", "--nosystem_rc", "--max_idle_secs=900"];
  const root = await mkdtemp(join(tmpdir(), "ompcode-native-worktree-"));
  const first = join(root, "repo");
  const second = join(root, "worktree");
  const bases = [join(root, "base-a"), join(root, "base-b")];
  const disk = join(root, "disk-cache");
  const bash = await resolveBashSh();
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
        ...startupArgs,
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
      { cwd: workspace, quiet: true, bazel: true, env: { BAZEL_SH: bash } },
    );
    return {
      ...result,
      bepPath: bep,
      events: await parseBuildEventFile(bep, targets, {
        checkTestsUpToDate: extra.includes("--check_tests_up_to_date"),
      }),
      cacheStates: await actionCacheStates(execution),
    };
  };
  const passed = (result, target) => {
    assert.equal(result.events.get(target)?.status, "PASSED", result.output);
    assert.equal(result.events.get(target)?.complete, true);
  };
  const targetList = ["gate-one", "gate-two", "gate-unrelated"];
  try {
    await artifactIOSelfTest(root);
    await mkdir(join(first, "scripts"), { recursive: true });
    await mkdir(join(first, "gates"), { recursive: true });
    await mkdir(join(first, "gates/inputs"), { recursive: true });
    const actionInputs = staticModuleInputs(repositoryRoot, ["scripts/test-gates-action.mjs"]);
    for (const file of actionInputs) {
      await mkdir(dirname(join(first, file)), { recursive: true });
      await cp(join(repositoryRoot, file), join(first, file));
    }
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
    await cp(join(repositoryRoot, "gates/runner.sh"), join(first, "gates/runner.sh"));
    await writeFile(
      join(first, "MODULE.bazel"),
      'module(name = "gate_fixture")\nbazel_dep(name = "rules_shell", version = "0.6.1")\nbazel_dep(name = "bazel_lib", version = "3.0.0")\n',
    );
    await cp(join(repositoryRoot, ".bazelversion"), join(first, ".bazelversion"));
    await writeFile(join(first, "shared.txt"), "shared-v1");
    await writeFile(join(first, "unrelated.txt"), "unrelated-v1");
    await writeFile(join(first, "broken.txt"), "fail");
    await writeFile(
      join(first, "fixture-helper.mjs"),
      'export const runtimeVersion = "runner-v1";\n',
    );
    await writeFile(
      join(first, "scripts/fixture-runner-helper.mjs"),
      'export const { runtimeVersion } = await import("../fixture-helper.mjs?fixture=runner#helper");\n',
    );
    const unconsumed = ["scripts/fixture-temporary.mjs", "scripts/test-gates-bazel-sync.mjs"];
    for (const file of unconsumed) await writeFile(join(first, file), "// unused v1\n");
    await writeFile(
      join(first, "scripts/test-gates-bazel-exec.mjs"),
      `import {realpathSync,appendFileSync,readFileSync,writeFileSync,watch} from 'node:fs';
import {fileURLToPath} from 'node:url'; import {dirname,join} from 'node:path';
import {runtimeVersion} from './fixture-runner-helper.mjs';
const root=dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const target=process.argv.at(-1);const record=(event)=>appendFileSync(join(root,'execution.jsonl'),JSON.stringify({target,event,runtimeVersion,time:Date.now()})+'\\n');
record('start');
if(target==='gate-lifecycle'){
 const mode=process.env.GATE_LIFECYCLE_MODE;
 writeFileSync(process.env.GATE_LIFECYCLE_RECEIPT,JSON.stringify({pid:process.pid,mode}));
 if(mode==='success'){console.log('fixture lifecycle success');process.exit(0);}
 if(mode==='failure'){console.error('fixture lifecycle failure');process.exit(1);}
 await new Promise(()=>{setInterval(()=>{},1000)});
}
if(target==='gate-broken'){ const mode=readFileSync(join(root,'broken.txt'),'utf8'); console.error('fixture failure log '+mode); if(mode==='hang') await new Promise(()=>{setInterval(()=>{},1000)}); if(mode==='skip') console.log('# SKIP fixture unverified'); process.exit(1); }
// Windows 调度可晚于原 700ms 工作窗口；等待实际准入收据，不能把错峰启动误判为串行执行。
const peers=${JSON.stringify(targetList)};
if(peers.includes(target)) await new Promise((done,fail)=>{const check=()=>{const log=readFileSync(join(root,'execution.jsonl'),'utf8');if(peers.every(peer=>log.includes('"target":"'+peer+'","event":"start"'))){watcher.close();done();}};const watcher=watch(root,check);watcher.on('error',fail);check();});
await new Promise(resolve=>setTimeout(resolve,700));record('end');console.log('fixture native log '+target+' '+runtimeVersion);
`,
    );
    const common = JSON.stringify(staticModuleInputs(first, ["scripts/test-gates-bazel-exec.mjs"]));
    const buildInputs = JSON.stringify(
      staticModuleInputs(first, ["scripts/test-gates-action.mjs"]),
    );
    const build = [
      'load("//:gates/rules.bzl", "gate_test", "gate_action")',
      ...[...targetList, "gate-broken"].map(
        (target) =>
          `gate_test(name="${target}",stage="${target}",size="small",data=${common}+["${target === "gate-unrelated" ? "unrelated.txt" : target === "gate-broken" ? "broken.txt" : "shared.txt"}"])`,
      ),
      `gate_test(name="gate-required",stage="gate-required",size="small",tags=["no-cache"],data=${common})`,
      `gate_test(name="gate-lifecycle",stage="gate-lifecycle",size="small",tags=["no-cache"],data=${common})`,
      `gate_action(name="gate-product",stage="gate-product",data=${buildInputs}+["shared.txt","gates/inputs/gate-product.json"])`,
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
        `import {materializeStageGroup} from './scripts/test-gates-action.mjs';await materializeStageGroup([${JSON.stringify(buildStage)}],${JSON.stringify(join(workspace, "bazel-bin"))});`,
      );
      const restored = await commandOutput(process.execPath, ["fixture-materialize.mjs"], {
        cwd: workspace,
        quiet: true,
      });
      assert.equal(restored.code, 0, restored.output);
      assert.equal(await readFile(join(workspace, "build/product.txt"), "utf8"), "shared-v1");
      if (process.platform === "win32") {
        // 属性不同会触发 Tweaked；即使 Robocopy 报 copied，同 size/mtime 的坏内容仍可能残留。
        const product = join(workspace, "build/product.txt");
        for (const mode of [0o444, 0o666]) {
          const original = await stat(product);
          await writeFile(product, "BROKEN-v1");
          await utimes(product, original.atime, original.mtime);
          await chmod(product, mode);
          const refreshed = await commandOutput(process.execPath, ["fixture-materialize.mjs"], {
            cwd: workspace,
            quiet: true,
          });
          assert.equal(refreshed.code, 0, refreshed.output);
          assert.equal(await readFile(product, "utf8"), "shared-v1");
        }
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
      assert.match(await readFile(cold.events.get(target).logPath, "utf8"), /runner-v1/u);
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
    for (const file of unconsumed) await writeFile(join(second, file), "// unused v2\n");
    const mtime = await invoke(second, bases[1], targetList);
    for (const target of targetList)
      assert.equal(
        mtime.events.get(target)?.cached,
        true,
        `mtime/unconsumed script or generator ${target}`,
      );
    await writeFile(
      join(second, "fixture-helper.mjs"),
      'export const runtimeVersion = "runner-v2";\n',
    );
    await writeFile(join(second, "build/product.txt"), "independent-cache-marker");
    const runnerChanged = await invoke(second, bases[1], [...targetList, "gate-product"]);
    assert.equal(runnerChanged.code, 0, runnerChanged.output);
    for (const target of targetList) {
      passed(runnerChanged, target);
      assert.equal(
        runnerChanged.events.get(target).cached,
        false,
        `runner closure invalidation ${target}`,
      );
      assert.match(await readFile(runnerChanged.events.get(target).logPath, "utf8"), /runner-v2/u);
    }
    assert.equal(runnerChanged.events.get("gate-product")?.status, "PASSED");
    assert.equal(
      await readFile(join(second, "build/product.txt"), "utf8"),
      "independent-cache-marker",
      "runner-only changes must not rerun the independent build action",
    );
    const beforeInvalidation = await readFile(join(second, "execution.jsonl"), "utf8");
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
      beforeInvalidation,
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
    await serverLifecycleSelfTest({ bazel, first, second, bases, bash, startupArgs, disk });
    console.log(
      "[PASS] native Git worktree disk-cache/mtime/dependency/failure/skip/timeout/concurrency/log fixtures",
    );
  } catch (error) {
    throw new Error(`${error.stack ?? error}\nNative fixture evidence retained: ${root}`, {
      cause: error,
    });
  } finally {
    // server 与缓存归 Bazel 所有；保留输出根、工作树和磁盘缓存，供原生空闲退出前继续使用。
    // runtime.json 含调用环境，只回收该次 fixture 的临时凭据，不递归删除仍在使用的目录。
    for (const workspace of [first, second])
      await rm(join(workspace, "gates/inputs/runtime.json"), { force: true });
  }
}
