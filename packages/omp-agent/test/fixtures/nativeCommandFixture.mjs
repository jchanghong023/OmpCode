import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
export const nativeCommandNames = [
  "wiki",
  "repo",
  "team",
  "plan",
  "loop",
  "goal",
  "advisor",
  "ultrathink",
  "orchestrate",
  "workflowz",
  "fullsend",
  "compact",
  "skill:native-command-fixture",
];
export const nativeModel = "zhipu-coding-plan/glm-5.3-flash";
export const nativeOmpBinary =
  process.env.OMP_NATIVE_E2E_BINARY ??
  process.env.OMP_RPC_BINARY_PATH ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "omp", "omp.exe")
    : "omp");

// 测试只读取指定模型的既有凭据并在子进程环境中传递；不复制认证库、不在证据或磁盘记录密钥。
export async function nativeCredentialEnv() {
  const result = await runFile(nativeOmpBinary, ["token", "zhipu-coding-plan", "--raw"], {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => {
    throw new Error("Cannot obtain existing zhipu-coding-plan credential (details withheld)");
  });
  const key = result.stdout.trim();
  assert.ok(key.length > 0 && !key.includes("\n"), "Expected a single native provider credential");
  return { ZHIPU_API_KEY: key };
}

export async function prepareNativeFixture(existingRoot) {
  const root = existingRoot
    ? resolve(existingRoot)
    : await mkdtemp(join(tmpdir(), "omp-native-command-e2e-"));
  const workspace = join(root, "workspace");
  const configRoot = join(root, "omp");
  const evidence = join(root, "evidence");
  const skill = join(workspace, ".omp", "skills", "native-command-fixture");
  if (existingRoot) {
    // 只复用本 helper 在系统临时目录创建的明确夹具；在任何写入之前核对身份。
    assert.equal(
      dirname(root).toLowerCase(),
      resolve(tmpdir()).toLowerCase(),
      "Existing native fixture must remain under the system temp directory",
    );
    assert.match(basename(root), /^omp-native-command-e2e-[a-z0-9]{6}$/iu);
    const [skillBody, readme, configBody] = await Promise.all([
      readFile(join(skill, "SKILL.md"), "utf8"),
      readFile(join(workspace, "README.md"), "utf8"),
      readFile(join(configRoot, "agent", "config.yml"), "utf8"),
    ]);
    assert.ok(
      skillBody.includes("NATIVE_SKILL_RESULT") &&
        readme.includes("NATIVE_WIKI_NEEDLE") &&
        configBody.includes(`  members: [${nativeModel}]`),
      "Existing root is not a native command fixture",
    );
  }
  await Promise.all([
    mkdir(skill, { recursive: true }),
    mkdir(join(configRoot, "agent"), { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const config = [
    "modelRoles:",
    ...["default", "plan", "smol", "slow", "compact", "advisor"].map(
      (role) => `  ${role}: ${nativeModel}${role === "plan" ? ":high" : ""}`,
    ),
    "team:",
    `  members: [${nativeModel}]`,
    "advisor:",
    "  enabled: false",
    "goal:",
    "  continuationModes: []",
    "compaction:",
    "  keepRecentTokens: 64",
    "skills:",
    "  enableCodexUser: false",
    "  enableClaudeUser: false",
    "  enableClaudeProject: false",
    "  enablePiUser: false",
    "  enablePiProject: true",
    "  enableAgentsUser: false",
    "  enableAgentsProject: false",
    "",
  ].join("\n");
  if (!existingRoot) {
    await writeFile(join(configRoot, "agent", "config.yml"), config);
    // 真实核的 GLM 默认 max 会作用于 team 独立子调用；测试采用同模型低思考默认值，
    // 保留实际支持的完整梯度及 wire/auth，避免把主进程 --thinking low 误当成子调用事实。
  }
  if (!existingRoot || process.env.OMP_NATIVE_E2E_LOW_CHILD_THINKING === "1") {
    await writeFile(
      join(configRoot, "agent", "models.yml"),
      [
        "providers:",
        "  zhipu-coding-plan:",
        "    modelOverrides:",
        "      glm-5.3-flash:",
        "        thinking:",
        "          mode: effort",
        "          efforts: [low, high, max]",
        "          defaultLevel: low",
        "          requiresEffort: true",
        "",
      ].join("\n"),
    );
  }
  if (existingRoot && process.env.OMP_NATIVE_E2E_SMALL_COMPACTION === "1") {
    // 真实默认窗口是 20000；短验收会话须降低已验证沙箱的保留预算才有可压缩前缀。
    // 只改该字段，保留 role、认证、其他 compaction 与所有非本任务配置。
    const path = join(configRoot, "agent", "config.yml");
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    const start = lines.findIndex((line) => /^compaction:\s*$/u.test(line));
    if (start < 0) lines.push("compaction:", "  keepRecentTokens: 64", "");
    else {
      const next = lines.findIndex((line, index) => index > start && /^[^\s#]/u.test(line));
      const end = next < 0 ? lines.length : next;
      const field = lines.findIndex(
        (line, index) => index > start && index < end && /^\s+keepRecentTokens:/u.test(line),
      );
      if (field < 0) lines.splice(start + 1, 0, "  keepRecentTokens: 64");
      else lines[field] = "  keepRecentTokens: 64";
    }
    await writeFile(path, lines.join("\n"));
  }
  if (!existingRoot) {
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: native-command-fixture\ndescription: Isolated native command acceptance skill.\n---\nWhen explicitly invoked, do not use tools. Reply with exactly NATIVE_SKILL_RESULT and preserve any supplied argument in a second line.\n",
    );
    await writeFile(
      join(workspace, "README.md"),
      "# Native command sandbox\n\nNATIVE_WIKI_NEEDLE describes the isolated command acceptance fixture.\n",
    );
    await writeFile(
      join(workspace, "sample.ts"),
      "export function nativeAnswer() { return 42; }\n",
    );
    await runFile("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
    await runFile("git", ["add", "README.md", "sample.ts", ".omp/skills"], {
      cwd: workspace,
      windowsHide: true,
    });
    await runFile(
      "git",
      [
        "-c",
        "user.name=Native Command E2E",
        "-c",
        "user.email=native-e2e@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Isolated fixture",
      ],
      { cwd: workspace, windowsHide: true },
    );
  }
  return { root, workspace, configRoot, evidence };
}

export function nativeFixtureEnv(fixture, credentials) {
  return {
    ...process.env,
    ...credentials,
    OMP_CONFIG_ROOT: fixture.configRoot,
    OMP_PROFILE: "",
    PI_PROFILE: "",
    PI_CODING_AGENT_DIR: "",
    PI_CONFIG_DIR: "",
    OMP_RPC_BINARY_PATH: nativeOmpBinary,
    OMP_RPC_ARGS_JSON: JSON.stringify([
      "--provider",
      "zhipu-coding-plan",
      "--model",
      "glm-5.3-flash",
      "--thinking",
      "low",
      "--no-extensions",
      "--no-rules",
      "--skills",
      "native-command-fixture",
      "--no-lsp",
      "--no-pty",
      "--approval-mode",
      "write",
    ]),
    ZCODE_WORKSPACE_IDENTITY: fixture.workspace,
  };
}
