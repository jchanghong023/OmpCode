import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { bazelOutputBase } from "./test-gates-bazel-locations.mjs";

// Diagnostic state only: no caller may use this index for admission or scheduling.
// SpawnExec schema: https://github.com/bazelbuild/bazel/blob/9.0.0/src/main/protobuf/spawn.proto
// Raw logs remain at the caller's immutable per-run paths; never copy credentials
// from native commandArgs/environmentVariables into the derived report or index.
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const label = (value) => (value?.startsWith("//") ? value : `//:${value}`);
const normalized = (value) => value.replaceAll("\\", "/");
const own = (object, key) => Object.hasOwn(object ?? {}, key);
// 单 action 记录入索引的最大输入摘要条数；超出部分按路径序截断并在诊断里标注。
const INPUT_DIGEST_LIMIT = 5000;

function cliIdentity(args) {
  const transportFlag =
    /^--(?:profile|memory_profile|explain|build_event_(?:json|binary|text)_file|(?:experimental_)?execution_log_(?:json|binary|compact)_file)$/u;
  const semantic = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    if (!transportFlag.test(flag)) {
      semantic.push(argument);
      continue;
    }
    // Keep the diagnostic format/flag identity, not its unique per-run path.
    semantic.push(`${flag}=<diagnostic-output>`);
    if (separator < 0 && index + 1 < args.length && !args[index + 1].startsWith("--")) index++;
  }
  return hash(semantic);
}

async function optionalText(path) {
  if (!path) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Bazel writes adjacent pretty-printed JSON objects, not a JSON array or NDJSON.
// Accept arrays too (official tooling/fixtures), without parsing compact protobuf.
function jsonObjects(text) {
  if (!text?.trim()) return [];
  if (text.trimStart().startsWith("[")) return JSON.parse(text);
  const objects = [];
  let depth = 0,
    start = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (!depth) start = index;
      depth++;
    } else if (character === "}") {
      if (--depth < 0) throw new Error("Invalid execution JSON framing");
      if (!depth) objects.push(JSON.parse(text.slice(start, index + 1)));
    }
  }
  if (depth || quoted) throw new Error("Incomplete execution JSON evidence");
  return objects;
}

function duration(value) {
  if (typeof value === "string" && /^\d+(?:\.\d+)?s$/u.test(value))
    return Number(value.slice(0, -1));
  if (value && typeof value === "object")
    return Number(value.seconds ?? 0) + Number(value.nanos ?? 0) / 1e9;
  return null;
}

function inputIdentity(input) {
  if (input.digest?.hash) {
    return hash([
      input.digest.hash,
      String(input.digest.sizeBytes ?? "0"),
      input.digest.hashFunctionName ?? "",
    ]);
  }
  if (input.symlinkTargetPath) return hash(["symlink", input.symlinkTargetPath]);
  // The native schema permits omitted digests for empty inputs. Missing digest
  // alone is not proof that a file was empty or unchanged.
  return null;
}

function summarizeSpawn(spawn) {
  const outputs = [...(spawn.listedOutputs ?? [])].map(normalized).sort();
  const target = spawn.targetLabel;
  const mnemonic = spawn.mnemonic ?? "unknown";
  const action = hash([target, mnemonic, outputs]);
  // 原因：全仓图生成等 action 的输入可达数万文件，逐项记录摘要曾使诊断索引膨胀到 56MB，
  // 每轮全量解析与写入拖慢入口并放大损坏窗口。依据：按路径排序后截断到上限并显式标注，
  // 比较语义对已记录前缀不变；截断事实在诊断中可见，不冒充完整输入清单。
  const declaredInputs = [...(spawn.inputs ?? [])].sort((a, b) =>
    normalized(a.path).localeCompare(normalized(b.path)),
  );
  const inputsTruncated = declaredInputs.length > INPUT_DIGEST_LIMIT;
  const inputs = Object.fromEntries(
    declaredInputs
      .slice(0, INPUT_DIGEST_LIMIT)
      .map((input) => [normalized(input.path), inputIdentity(input)]),
  );
  const environment = Object.fromEntries(
    (spawn.environmentVariables ?? []).map(({ name, value }) => [name, hash(value ?? "")]),
  );
  const command = spawn.commandArgs ?? spawn.commandLine;
  const cacheHit = spawn.cacheHit === true || /cache hit/iu.test(spawn.runner ?? "");
  // proto3 defaults omit cacheHit=false; a non-cache runner is positive evidence.
  const reran = cacheHit ? false : spawn.runner ? true : null;
  return {
    action,
    target,
    mnemonic,
    outputs,
    inputs,
    inputsTruncated: inputsTruncated || undefined,
    environment,
    command: command === undefined ? null : hash(command),
    actionDigest: spawn.digest?.hash ? hash(spawn.digest) : null,
    reran,
    seconds: reran === true ? duration(spawn.metrics?.executionWallTime) : null,
    exitCode: spawn.exitCode ?? 0,
  };
}

function compareInputs(previous, current) {
  const changes = [];
  for (const path of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[path],
      after = current[path];
    if (!own(previous, path))
      changes.push({ path, kind: "added", evidence: "execution-input-membership" });
    else if (!own(current, path))
      changes.push({ path, kind: "removed", evidence: "execution-input-membership" });
    else if (before !== null && after !== null && before !== after) {
      changes.push({
        path,
        kind: "digest-changed",
        before,
        after,
        evidence: "execution-input-digest",
      });
    }
  }
  return changes;
}

function compareEnvironment(previous, current) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((name) => previous[name] !== current[name])
    .map((name) => ({
      name,
      kind: !own(previous, name) ? "added" : !own(current, name) ? "removed" : "changed",
    }));
}

function bepTargets(text) {
  const targets = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const target =
      event.id?.testResult?.label ??
      event.id?.targetCompleted?.label ??
      event.id?.actionCompleted?.label;
    if (!target) continue;
    const state = targets.get(target) ?? { target, reran: null, seconds: null };
    if (event.completed) state.status = event.completed.success ? "PASSED" : "FAILED";
    if (event.testResult) {
      const result = event.testResult;
      const cached = result.cachedLocally === true || result.executionInfo?.cachedRemotely === true;
      state.reran = state.reran === true || !cached;
      state.seconds =
        (state.seconds ?? 0) + (cached ? 0 : Number(result.testAttemptDurationMillis ?? 0) / 1000);
      state.status = result.status;
    }
    if (event.action) {
      state.actionEvent = true;
      if (event.action.success === false) state.status = "FAILED";
    }
    targets.set(target, state);
  }
  return targets;
}

function sourceChanges(previous, current) {
  const same = Boolean(
    previous && previous.head === current?.head && previous.contentHash === current?.contentHash,
  );
  return {
    sameSnapshot: previous ? same : null,
    candidates: [...new Set([...(previous?.dirty ?? []), ...(current?.dirty ?? [])])],
    precision: "snapshot-only; dirty entries are candidates, not causal evidence",
  };
}

function describeAction(current, previous, forced, firstRun) {
  const inputChanges = previous ? compareInputs(previous.inputs, current.inputs) : [];
  const commandChanged =
    previous && previous.command !== null && current.command !== null
      ? previous.command !== current.command
      : null;
  const environmentChanges = previous
    ? compareEnvironment(previous.environment, current.environment)
    : [];
  const reasons = [];
  if (forced) reasons.push("声明为必跑准备");
  if (current.reran === false) reasons.push("缓存命中；不是实际重跑");
  else {
    if (inputChanges.length) reasons.push("确证实际 action 输入摘要或成员变化");
    if (commandChanged) reasons.push("命令身份变化（仅摘要，无参数值）");
    if (environmentChanges.length) reasons.push("环境变量身份变化（仅变量名，无值）");
    if (!previous) reasons.push(firstRun ? "待定位：首轮无基线" : "待定位：该 action 无可比较基线");
    else if (!inputChanges.length && !commandChanged && !environmentChanges.length && !forced) {
      reasons.push("待定位：未取得具体输入、命令或环境变化证据");
    }
    if (current.reran === null) reasons.push("待定位：缺少实际执行或缓存命中证据");
  }
  return {
    target: current.target,
    action: current.action,
    mnemonic: current.mnemonic,
    reran: current.reran,
    seconds: current.seconds,
    exitCode: current.exitCode,
    reasons,
    inputChanges,
    commandChanged,
    environmentChanges,
    actionDigestChanged:
      previous?.actionDigest && current.actionDigest
        ? previous.actionDigest !== current.actionDigest
        : null,
    evidence: "native SpawnExec; input changes describe action identity, not cache-miss policy",
  };
}

/**
 * Called after one Bazel invocation, irrespective of its real exit status.
 * invocation.id is a stable risk-group ID, NOT a unique run ID. evidenceDir and
 * raw paths must instead be unique per run, so previous raw evidence is retained.
 * CLI is hashed only; this module never changes flags or interprets pass/fail.
 */
export async function recordInvalidationEvidence({
  snapshot,
  evidenceDir,
  invocation,
  indexPath = join(bazelOutputBase, "diagnostics", "invalidation-index.json"),
}) {
  const {
    id,
    bepPath,
    executionPath,
    explainPath,
    cli = [],
    forcedExternalTargets = [],
  } = invocation;
  if (!id || !evidenceDir) throw new Error("Diagnostic invocation.id and evidenceDir are required");
  const [indexText, executionText, bepText, explainText] = await Promise.all([
    optionalText(indexPath),
    optionalText(executionPath),
    optionalText(bepPath),
    optionalText(explainPath),
  ]);
  // 原因：索引仅是诊断状态（本模块头注：不得用于准入或调度）。曾被硬截止中断的写入会留下
  // 截断 JSON；整文件 JSON.parse 抛错曾使后续每次入口在 bazel-graph 阶段直接失败。
  // 依据：损坏索引按"不存在"处理并记录说明，仅丢失跨轮比较基线（下一轮自动重建），不影响门禁判定。
  let index = { version: 1, invocations: {} };
  if (indexText) {
    try {
      index = JSON.parse(indexText);
    } catch (error) {
      console.log(
        `[invalidation] ${id}: 待定位：诊断索引损坏（${error.message}），按首轮无基线重建`,
      );
    }
  }
  if (index.version !== 1) {
    console.log(`[invalidation] ${id}: 诊断索引版本不符，按首轮无基线重建`);
    index = { version: 1, invocations: {} };
  }
  const previous = index.invocations[id];
  const actionsIndex = { ...previous?.actions };
  const forced = new Set(forcedExternalTargets.map(label));
  const targets = bepTargets(bepText);
  const actions = [];
  const identities = new Set();
  const notes = ["仅诊断；不决定通过、缓存准入或调度；真实 Bazel 结果由调用方保留"];
  if (!previous) notes.push("首轮无基线：不能归因于变更候选文件");
  if (executionText === undefined) {
    notes.push("待定位：无原生 execution JSON；不能将日志缺失解释为缓存命中");
  }
  for (const spawn of jsonObjects(executionText)) {
    if (!spawn.targetLabel) continue;
    const current = summarizeSpawn(spawn);
    if (!current.outputs.length) {
      notes.push(`待定位：${current.target} 的 action 缺少稳定输出身份；不比较其输入`);
      actions.push(describeAction(current, undefined, forced.has(current.target), !previous));
      continue;
    }
    // Duplicate output identities can represent retries. Each run is reported,
    // but all compare to the previous invocation, never to a retry in this run.
    identities.add(current.target);
    actions.push(
      describeAction(
        current,
        previous?.actions?.[current.action],
        forced.has(current.target),
        !previous,
      ),
    );
    actionsIndex[current.action] = current;
  }
  for (const target of targets.values()) {
    if (identities.has(target.target)) continue;
    const reasons = [];
    if (forced.has(target.target)) reasons.push("声明为必跑准备");
    if (target.reran === false) reasons.push("BEP 测试缓存命中；不是实际重跑");
    else
      reasons.push(
        previous ? "待定位：缺少可关联的 execution action 输入证据" : "待定位：首轮无基线",
      );
    actions.push({
      ...target,
      action: null,
      reasons,
      inputChanges: [],
      commandChanged: null,
      environmentChanges: [],
    });
  }
  const reportPath = join(evidenceDir, "invalidation.json");
  const evidence = { bepPath, executionPath, explainPath, reportPath };
  const report = {
    version: 1,
    invocationId: id,
    baseline: previous ? "available" : "first-run",
    previousEvidence: previous?.evidence ?? null,
    evidence,
    sourceChanges: sourceChanges(previous?.snapshot, snapshot),
    cliIdentityChanged:
      previous?.cliIdentityScheme === "transport-paths-normalized-v1"
        ? previous.cliIdentity !== cliIdentity(cli)
        : null,
    explain: {
      available: explainText !== undefined,
      identity: explainText === undefined ? null : hash(explainText),
    },
    actions,
    notes,
    compactIntegration:
      "execution_log_compact_file 与 execution_log_json_file 互斥；精确诊断须在显式诊断运行中选择 JSON，或使用官方 execution-log 工具将 compact 解码为完整 SpawnExec JSON 后传入 executionPath；本模块不解析 protobuf，不将缺失 JSON 解释为缓存命中。",
  };
  // Keep cached/absent actions: persistent action-cache hits emit no SpawnExec.
  // Retain old report references, and never delete or replace raw evidence files.
  index.invocations[id] = {
    snapshot,
    cliIdentity: cliIdentity(cli),
    cliIdentityScheme: "transport-paths-normalized-v1",
    actions: actionsIndex,
    evidence,
    history: [...(previous?.history ?? []), ...(previous?.evidence ? [previous.evidence] : [])],
  };
  await Promise.all([
    mkdir(evidenceDir, { recursive: true }),
    mkdir(dirname(indexPath), { recursive: true }),
  ]);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  // 原因：索引跨轮存活；硬截止或异常退出若打断 writeFile 会留下截断 JSON，损坏下一次入口。
  // 依据：临时文件 + rename 原子替换，中断最多丢失本轮索引更新，不产生半写状态。
  const indexTemp = `${indexPath}.tmp`;
  await writeFile(indexTemp, `${JSON.stringify(index)}\n`);
  await rename(indexTemp, indexPath);
  console.log(
    `[invalidation] ${id}: ${previous ? "已有诊断基线" : "待定位：首轮无基线"}；${report.sourceChanges.sameSnapshot === true ? "源码快照一致" : "源码快照仅作候选，不作因果依据"}`,
  );
  if (!actions.length)
    console.log(
      `[invalidation] ${id}: 待定位：本次无可关联 action 执行证据，不能据此宣称重跑或缓存命中`,
    );
  for (const action of actions) {
    const timing =
      action.reran === true
        ? `实际重跑 ${action.seconds === null ? "耗时待定位" : `${action.seconds.toFixed(3)}s`}`
        : action.reran === false
          ? "未重跑"
          : "执行状态待定位";
    console.log(
      `[invalidation] ${id} ${action.target} ${action.action?.slice(0, 12) ?? "BEP"}: ${timing}；${action.reasons.join("；")}`,
    );
    for (const change of action.inputChanges) console.log(`  ${change.kind}: ${change.path}`);
    if (action.environmentChanges.length)
      console.log(`  environment: ${action.environmentChanges.map(({ name }) => name).join(", ")}`);
  }
  return { ...report, reportPath };
}
