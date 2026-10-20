import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bazelizeStages, runBazelStage } from "./test-gates-bazel.mjs";
import { repositoryRoot } from "./test-gates-bazel-locations.mjs";
import { exists, gitText, snapshot } from "./test-gates-snapshot.mjs";

export const graphStage = {
  id: "bazel-graph",
  command: "node",
  args: [
    "scripts/test-gates-bazel-sync.mjs",
    "--output",
    "gates/inputs/generated-build.bazel",
    "--changed-files-control",
    "gates/inputs/gate-bazel-graph.json",
  ],
  action: true,
  kind: "check",
  outputs: ["gates/inputs/generated-build.bazel"],
};

export async function ensureBazelGraph(context, { readOnly = false } = {}) {
  // 名字集合是图的语义输入，不在动作内读取未声明的 Git index/worktree 状态。
  const changes = await Promise.all([
    gitText(["diff", "--name-only", "-z", "HEAD"]),
    gitText(["diff", "--name-only", "-z"]),
    gitText(["diff", "--cached", "--name-only", "-z", "HEAD"]),
    gitText(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const changedFiles = [
    ...new Set(changes.flatMap((text) => text.split("\0")).filter(Boolean)),
  ].sort();
  const recipe = {
    ...graphStage,
    changedFiles,
    // fastPlan 还依据存在性筛选格式文件；原 scope 排除目录内的删除也要使图失效。
    changedFilePresence: await Promise.all(changedFiles.map((name) => exists(name))),
  };
  const transport = join(repositoryRoot, graphStage.outputs[0]);
  // 传输只在桥接 owner 的退出清理链中清空；客户端 close 时动作树可能尚未终止。
  const stage = bazelizeStages([recipe])[0];
  // 只读诊断必须先确认当前输入的原生缓存；不能先生成或把旧产物当作当前图。
  if (readOnly) stage.bazel.cacheOnly = true;
  const result = await runBazelStage(stage, {
    ...context,
    // 仅用于本次原生失效诊断；调用者在生成成功后另取最终源码验收快照。
    snapshot: context.snapshot ?? (context.diagnostics ? await snapshot() : undefined),
    nativeStages: [recipe],
  });
  if (result.status !== "PASS") return result;
  let generated;
  try {
    generated = await readFile(
      readOnly
        ? join(repositoryRoot, "bazel-bin/gates/artifacts/gate-bazel-graph", graphStage.outputs[0])
        : transport,
    );
  } catch (error) {
    if (!readOnly || error.code !== "ENOENT") throw error;
    return {
      ...result,
      status: "CACHE_MISS",
      reason: "Generated Bazel graph artifact is missing",
    };
  }
  const destination = join(repositoryRoot, "BUILD.bazel");
  let existing;
  try {
    existing = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (readOnly && !existing?.equals(generated))
    return { ...result, status: "CACHE_MISS", reason: "Root BUILD.bazel is out of date" };
  // 保留相同内容 BUILD 的 mtime；Bazel 的产物与缓存才是唯一生成事实。
  if (!existing?.equals(generated)) await writeFile(destination, generated);
  return result;
}
