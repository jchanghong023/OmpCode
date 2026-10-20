import { appendFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot, gatesInputsDir } from "./test-gates-bazel-locations.mjs";
import { prepareBazelEnvironment } from "./test-gates-bazel-runtime.mjs";
import { commandOutput, startCommand, windowsSystemToolPath } from "./test-gates-process.mjs";

const targetName = (id) => `gate-${id.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;

function ownedPath(root, output) {
  const path = resolve(root, output);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Invalid declared gate output: ${output}`);
  return path;
}

async function copyOutput(source, destination) {
  if (process.platform !== "win32") {
    await cp(source, destination, { recursive: true, force: true });
    return;
  }
  // 数千个 TS 产物的逐文件 JS 复制会耗尽门禁预算；用系统并行复制，不另建增量账本。
  const directory = (await stat(source)).isDirectory();
  const result = await commandOutput(
    windowsSystemToolPath("robocopy.exe"),
    [
      ...(directory
        ? [source, destination]
        : [dirname(source), dirname(destination), basename(source)]),
      ...(directory ? ["/E"] : []),
      "/MT:32",
      "/COPY:DAT",
      "/DCOPY:DT",
      // 必须复制 A 属性后再去掉 R；只用 DT 时 /A-:R 无效，Bazel 只读产物会使后续编译失败。
      "/A-:R",
      "/SL",
      "/SJ",
      "/IS",
      "/IT",
      // 同 size/mtime、不同 change-time 属于 Modified，IS/IT 不包含，仍须完整回填。
      "/IM",
      "/R:0",
      "/W:0",
      "/NFL",
      "/NDL",
      "/NJH",
      "/NJS",
      "/NP",
    ],
    { quiet: true, stageId: "artifact-copy" },
  );
  // Robocopy 的 0–7 是成功/文件差异状态，8 起才是复制失败。
  if (result.reason || result.code >= 8 || result.code < 0)
    throw new Error(`Artifact copy failed (${result.code}): ${result.output.trim()}`);
}

// Bazel's declared tree is the only reusable product. Copying merges owned
// subtrees and never clears compiler caches or another stage's sibling outputs.
export async function materializeStageArtifacts(stage, binRoot, workspace = repositoryRoot) {
  if (!stage.outputs?.length) return;
  const artifact = join(binRoot, "gates", "artifacts", targetName(stage.id));
  await copyOutput(artifact, workspace);
  if (process.platform !== "win32") {
    // 只恢复声明产物的 owner 写权限，保留可执行位；不修改源码或共享缓存的权限。
    const result = await commandOutput(
      "chmod",
      ["-R", "u+w", ...stage.outputs.map((output) => ownedPath(workspace, output))],
      { quiet: true, stageId: "artifact-writable" },
    );
    if (result.code !== 0) throw new Error(`Artifact permissions failed: ${result.output.trim()}`);
  }
}

async function prepareWritableOutputs(stage, workspace) {
  for (const output of stage.outputs ?? []) {
    const target = ownedPath(workspace, output);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // 旧缓存曾把只读属性带回工作区；缓存 miss 的生产者也必须能覆盖自己的产物。
    // 只清理声明输出的 R 属性，不修改源码、其他目标或共享缓存。
    const result =
      process.platform === "win32"
        ? await commandOutput(
            windowsSystemToolPath("attrib.exe"),
            [
              "-R",
              info.isDirectory() ? join(target, "*") : target,
              ...(info.isDirectory() ? ["/S", "/D"] : []),
            ],
            { quiet: true, stageId: "artifact-writable" },
          )
        : await commandOutput("chmod", ["-R", "u+w", target], {
            quiet: true,
            stageId: "artifact-writable",
          });
    if (result.code !== 0)
      throw new Error(`Cannot prepare writable declared output ${output}: ${result.output.trim()}`);
  }
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
      await materializeStageArtifacts(
        dependencyControl.stage,
        resolve(artifact, "../../.."),
        workspace,
      );
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
          if (stage.kind !== "compile" || notified) return;
          tail = (tail + text).slice(-12000);
          const diagnostic = tail.match(/^[^\r\n]*\berror TS\d+: [^\r\n]+/mu);
          if (diagnostic) {
            notified = true;
            frame("failure", { code: 1, reason: diagnostic[0].trim() });
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
    for (const outputPath of stage.outputs ?? []) {
      const destination = ownedPath(artifact, outputPath);
      await mkdir(dirname(destination), { recursive: true });
      await copyOutput(ownedPath(workspace, outputPath), destination);
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
