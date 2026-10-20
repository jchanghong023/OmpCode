import { appendFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot, gatesInputsDir } from "./test-gates-bazel-locations.mjs";
import { prepareBazelEnvironment } from "./test-gates-bazel-runtime.mjs";
import { createArtifactIO } from "./test-gates-artifacts.mjs";
import { cancelCommands, skipSignalPattern, startCommand, stopAll } from "./test-gates-process.mjs";

const targetName = (id) => `gate-${id.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;

function ownedPath(root, output) {
  const path = resolve(root, output);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Invalid declared gate output: ${output}`);
  return path;
}

// Bazel's declared tree is the only reusable product. Copying merges owned
// subtrees and never clears compiler caches or another stage's sibling outputs.
async function materializeStageArtifacts(
  stage,
  binRoot,
  workspace = repositoryRoot,
  io = createArtifactIO(),
) {
  if (!stage.outputs?.length) return;
  const artifact = join(binRoot, "gates", "artifacts", targetName(stage.id));
  // 调度按声明输出判独立，实际复制也必须限制在同一边界，不能并行遍历整棵 artifact。
  // 逐声明输出保留 stage 内原合并/覆盖顺序，不碰未声明兄弟输出或共享缓存属性。
  for (const output of stage.outputs) {
    const destination = ownedPath(workspace, output);
    await mkdir(dirname(destination), { recursive: true });
    await io.copy(ownedPath(artifact, output), destination);
  }
}

const outputPaths = (stage, workspace) =>
  (stage.outputs ?? []).map((output) => {
    const path = ownedPath(workspace, output);
    return process.platform === "win32" ? path.toLowerCase() : path;
  });

// 跨动作依赖恢复锁：真实工作区可写缓存下的独占文件；持锁者恢复，超时抢占防陈锁卡死。
async function withRestoreLock(workspace, key, run) {
  const lockRoot = join(workspace, "node_modules", ".cache", "gate-restore-locks");
  await mkdir(lockRoot, { recursive: true });
  const lockPath = join(lockRoot, `${key}.lock`);
  const acquire = () => open(lockPath, "wx");
  let handle;
  const deadline = Date.now() + 120000;
  while (!handle) {
    try {
      handle = await acquire();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        // 陈锁（持锁动作被强杀）不阻塞分发；抢占后由本次恢复收敛最终内容。
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await run();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}
const overlappingOutputs = (left, right) =>
  left.some((a) =>
    right.some(
      (b) =>
        a === b ||
        a.startsWith(`${b}/`) ||
        b.startsWith(`${a}/`) ||
        a.startsWith(`${b}\\`) ||
        b.startsWith(`${a}\\`),
    ),
  );

// 原先按 stage 分批会把单 stage 的多个输出串行化；按声明顺序拆成单输出操作解除瓶颈。
// 只准入至多四个互不重叠路径，首个冲突即封住本批，保留覆盖顺序且不越过冲突挑任务。
export async function materializeStageGroup(
  stages,
  binRoot,
  { workspace = repositoryRoot, clock } = {},
) {
  const pending = stages.flatMap((stage) =>
    (stage.outputs ?? []).map((output) => {
      const singleOutputStage = { ...stage, outputs: [output] };
      return { stage: singleOutputStage, paths: outputPaths(singleOutputStage, workspace) };
    }),
  );
  const io = createArtifactIO();
  for (let index = 0; index < pending.length;) {
    const batch = [pending[index++]];
    while (
      batch.length < 4 &&
      index < pending.length &&
      batch.every((member) => !overlappingOutputs(member.paths, pending[index].paths))
    )
      batch.push(pending[index++]);
    const copies = batch.map(({ stage }) =>
      materializeStageArtifacts(stage, binRoot, workspace, io),
    );
    try {
      await Promise.all(copies);
    } catch (error) {
      io.fail(error);
      // Stop admission before awaiting cleanup. stopAll owns native copy trees
      // and the gate's existing budget/cancellation path; retain the first error.
      cancelCommands();
      await stopAll(clock).catch(() => {});
      await Promise.allSettled(copies);
      throw error;
    }
  }
}

async function prepareWritableOutputs(stage, workspace) {
  const io = createArtifactIO();
  for (const output of stage.outputs ?? []) await io.prepare(ownedPath(workspace, output));
}

async function runAction() {
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const target = argument("--stage");
  const output = argument("--output");
  if (!target || !output) throw new Error("Gate action requires --stage and --output");
  // Resolve execroot output before prepareBazelEnvironment changes cwd.
  const artifact = resolve(output);
  const control = JSON.parse(await readFile(join(gatesInputsDir, `${target}.json`), "utf8"));
  const stage = control.stage;
  const { workspace, env } = await prepareBazelEnvironment(stage, control);
  const live = join(gatesInputsDir, `${target}.live`);
  const frame = (event, extra = {}) => {
    if (event === "failure")
      appendFileSync(
        live,
        `\u001eOMP_TEST_FAILURE ${JSON.stringify({ name: stage.id, error: extra.reason ?? `Build action failed with code ${extra.code}` })}\n`,
      );
    else
      appendFileSync(
        live,
        `\u001eOMP_GATE_KIND ${JSON.stringify({ event, id: stage.id, kind: stage.kind, time: Number(process.hrtime.bigint() / 1_000_000n), ...extra })}\n`,
      );
  };
  let activeKind = "check";
  frame("start", { kind: activeKind });
  try {
    for (const dependency of stage.dependsOn ?? []) {
      const dependencyControl = JSON.parse(
        await readFile(join(gatesInputsDir, `${targetName(dependency)}.json`), "utf8"),
      );
      // 原因：同一 bazel 调用内并行动作可能同时把同一共享依赖产物恢复到真实工作区同一路径，
      // 曾使一方 chmod/copyFile 撞上另一方的替换（ENOENT/EEXIST）。依据：按依赖目标在真实
      // 工作区的可写缓存目录加跨动作文件锁，恢复自身串行；锁只覆盖恢复段，不覆盖业务命令。
      await withRestoreLock(workspace, targetName(dependency), async () => {
        await materializeStageArtifacts(
          dependencyControl.stage,
          resolve(artifact, "../../.."),
          workspace,
        );
      });
    }
    await prepareWritableOutputs(stage, workspace);
    frame("end", { kind: activeKind });
    activeKind = stage.kind;
    frame("start", { kind: activeKind });
    const args = stage.args.map((arg) => arg.replaceAll("${WORKSPACE}", workspace));
    const code = await new Promise((done, fail) => {
      const child = startCommand(stage.command, args, {
        cwd: workspace,
        env: {
          ...process.env,
          ...env,
          ...(stage.head ? { ZCODE_COMMIT: stage.head.slice(0, 8) } : {}),
        },
        stageId: stage.id,
      });
      let notified = false;
      for (const [stream, destination] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ]) {
        stream.setEncoding("utf8");
        let tail = "";
        stream.on("data", (text) => {
          destination.write(text);
          if (notified) return;
          tail = (tail + text).slice(-12000);
          const skipped = skipSignalPattern.test(tail);
          const diagnostic =
            stage.kind === "compile" ? tail.match(/^[^\r\n]*\berror TS\d+: [^\r\n]+/mu) : undefined;
          if (skipped || diagnostic) {
            notified = true;
            frame("failure", {
              code: 1,
              reason: skipped
                ? "Gate action reported skipped or unverified work"
                : diagnostic[0].trim(),
            });
          }
        });
      }
      child.once("error", fail);
      child.once("close", (status) => done(notified ? 1 : (status ?? 1)));
    });
    frame("end", { kind: activeKind });
    activeKind = undefined;
    if (code !== 0) {
      frame("failure", { code });
      process.exitCode = code;
      return;
    }
    activeKind = "check";
    frame("start", { kind: activeKind });
    await mkdir(artifact, { recursive: true });
    const io = createArtifactIO();
    for (const outputPath of stage.outputs ?? []) {
      const destination = ownedPath(artifact, outputPath);
      await mkdir(dirname(destination), { recursive: true });
      await io.copy(ownedPath(workspace, outputPath), destination);
    }
  } catch (error) {
    frame("failure", { code: 1 });
    throw error;
  } finally {
    if (activeKind) frame("end", { kind: activeKind });
  }
}

// Bazel 经 execroot 符号链接启动脚本；argv 与 import.meta 的字符串路径可能不同，
// 必须比较真实文件，否则动作会跳过执行却返回 0，产生空 tree artifact。
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  await runAction();
