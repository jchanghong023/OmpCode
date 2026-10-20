import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { commandOutput } from "./test-gates-process.mjs";

let packagingState;
let packagingCleanup;

function packagingTemplate() {
  assert.equal(process.platform, "win32", "Local packaging validation is Windows-only");
  const require = createRequire(resolve("packages/desktop/package.json"));
  return join(
    dirname(require.resolve("app-builder-lib/package.json")),
    "templates",
    "nsis",
    "installSection.nsh",
  );
}

export async function snapshotPackagingState(template = packagingTemplate()) {
  assert.ok(!packagingState, "Packaging must not overlap another packaging operation");
  // 先登记读取所有权再 await；取消清理等待同一读取，不能漏掉迟到的快照。
  console.log("[gate] packaging snapshot begin");
  const ready = readFile(template);
  packagingState = { template, ready };
  await ready;
  console.log("[gate] packaging snapshot complete files=1");
}

export function restorePackagingState() {
  if (packagingCleanup) return packagingCleanup;
  packagingCleanup = Promise.resolve()
    .then(async () => {
      if (!packagingState) return;
      console.log("[gate] packaging restoration begin");
      const { template, ready } = packagingState;
      const bytes = await ready;
      if (!(await readFile(template)).equals(bytes)) await writeFile(template, bytes);
      packagingState = undefined;
      console.log("[gate] packaging restoration complete files=1");
    })
    .finally(() => {
      packagingCleanup = undefined;
    });
  return packagingCleanup;
}

export function stageOutcome(result) {
  return {
    status: result.code ? "FAIL" : result.skipped ? "UNVERIFIED_MISSING_ENV" : "PASS",
    exitCode: result.code,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.skipped ? { reason: "Existing test reported skipped/unverified coverage" } : {}),
  };
}

// 普通 runner 与 GUI fixture 共享隔离，不让普通静态闭包加载 GUI 收据与窗口实现。
export async function prepareStageEnvironment(stage, context) {
  // 生命周期目标复用外层已隔离的环境，避免每个 phase 再创建一套 HOME/配置根。
  if (context.preparedEnv) return { ...context.preparedEnv, ...stage.env };
  const env = { ...stage.env };
  // 门禁可能宿主在 ZCode 产品会话内，宿主会把本机安装运行时与个人 provider 配置注入这两个变量；
  // 继承后同一源码快照的构建校验、打包嵌入与 GUI 随宿主环境漂移（安装运行时 revision 31 的
  // highspeed 卡曾使 tsup 构建期 Release 校验失败）。清除继承值，让构建校验与打包统一使用仓库受控
  // config/provider/zcode-builtin.json、GUI 不读取用户日常配置；校验、打包与断言语义本身不变。
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)]))
    if (/^ZCODE_(?:BUILTIN|PERSONAL)_PROVIDER_CONFIG_FILE$/iu.test(key)) env[key] = undefined;
  if (stage.realOmp) {
    // startCommand 会重新合并 process.env；必须覆盖 Windows 大小写别名，不能只删副本。
    // broker 启动即取快照，配置叠加可改子模型；离线公司通道与 HOME/.env 也会重读用户凭据。
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)]))
      if (
        /^(?:OMP_RPC_ARGS_JSON|OMP_E2E_MODEL_SELECTOR|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_FILES|OMP_AUTH_BROKER_.+|CLAUDE_CONFIG_DIR|OMP_OFFLINE|HOME|USERPROFILE|(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL)$/iu.test(
          key,
        )
      )
        env[key] = undefined;
    const home = await mkdtemp(join(tmpdir(), "ompcode-mock-home-"));
    await mkdir(join(home, ".claude"));
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      OMP_CONFIG_ROOT: join(home, ".omp"),
      OMP_PROFILE: "",
      PI_PROFILE: "",
      OMPCODE_CENTOS7_PROFILE: "",
      PI_CONFIG_DIR: "",
      PI_CODING_AGENT_DIR: "",
      PI_CONFIG_FILES: "",
      OMP_OFFLINE: "",
      OMP_RPC_BINARY_PATH: context.omp,
      OMP_AGENT_SKIP_REAL_E2E: "0",
    });
  }
  return env;
}

export async function regularStage(stage, context) {
  if (stage.realOmp && !context.omp)
    return {
      status: "UNVERIFIED_MISSING_ENV",
      reason: "No installed omp; local mock-model validation still requires the real binary",
    };
  const env = await prepareStageEnvironment(stage, context);
  let args = stage.args;
  let packagingOutput;
  if (stage.packaging) {
    packagingOutput = await mkdtemp(join(tmpdir(), "ompcode-local-package-"));
    args = [...args, `--config.directories.output=${packagingOutput}`];
    Object.assign(env, {
      ZCODE_DESKTOP_DIST_DIR: packagingOutput,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_LINK: "",
      WIN_CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      WIN_CSC_KEY_PASSWORD: "",
    });
    console.log(`[gate] stage=${stage.id} packaging preparation begin evidence=${packagingOutput}`);
    await snapshotPackagingState();
    console.log(`[gate] stage=${stage.id} packaging execution begin evidence=${packagingOutput}`);
  }
  try {
    const result = stageOutcome(
      await commandOutput(stage.command, args, {
        stageId: stage.id,
        env,
        clock: context.clock,
        failFast: true,
        captureOutput: false,
        onFailure: context.onFailure,
        failFastTests: stage.kind === "test" && args.includes("--test"),
        failFastCompiler: stage.kind === "compile",
      }),
    );
    return packagingOutput ? { ...result, packagingOutput } : result;
  } finally {
    if (stage.packaging) await restorePackagingState();
  }
}
