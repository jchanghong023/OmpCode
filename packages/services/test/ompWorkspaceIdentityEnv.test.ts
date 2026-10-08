import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { buildAgentWorkspaceIdentityEnv } from "../src/runtime-tools/agentProxyEnv.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

test("当前 Host workspace identity 覆盖继承环境，空 identity 使用本地路径", () => {
  for (const target of [
    { workspacePath: "C:/fixture/local" },
    { workspacePath: "C:/fixture/local", workspaceIdentity: " " },
    { workspacePath: "/remote/project", workspaceIdentity: "remote-fixture-identity" },
  ]) {
    const workspaceKey = resolveWorkspaceKey(target);
    assert.deepEqual(
      {
        ZCODE_WORKSPACE_IDENTITY: "parent-other-workspace",
        ...buildAgentWorkspaceIdentityEnv(workspaceKey),
      },
      { ZCODE_WORKSPACE_IDENTITY: workspaceKey },
    );
  }
});

// 真实 stdio 进程严格校验 Service 的协议目标与进程身份；不调用模型或扫描本机技能。
const strictAgent = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method !== "skills/referenceCatalog") {
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "unsupported" } }) + "\\n");
    return;
  }
  const workspace = request.params.workspace;
  const actualKey = process.env.ZCODE_WORKSPACE_IDENTITY || process.cwd();
  appendFileSync(process.argv[1], JSON.stringify({ expectedKey: workspace.workspaceKey, actualKey, sessionId: request.params.sessionId }) + "\\n");
  if (workspace.workspaceKey !== actualKey) {
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32602, message: "invalid skill catalog target" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result: {
    authority: request.params.sessionId ? "session" : "workspace",
    skills: [{ id: "skill:native-fixture", name: "native-fixture", description: "Native command", scope: "omp", enabled: true }],
  } }) + "\\n");
});
input.on("close", () => process.exit(0));
`;

test("Service 到真实子进程的技能请求按本地或远端身份隔离，不受父环境与 command env 污染", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-workspace-id-"));
  const previousIdentity = process.env.ZCODE_WORKSPACE_IDENTITY;
  process.env.ZCODE_WORKSPACE_IDENTITY = "parent-other-workspace";
  setDataBaseDir(root);
  const requestPath = join(root, "requests.jsonl");
  const service = createZCodeAgentService({
    requestTimeoutMs: 2_000,
    commandResolver: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", strictAgent, requestPath],
      env: { ZCODE_WORKSPACE_IDENTITY: "command-other-workspace" },
    }),
  });
  try {
    for (const target of [
      { workspacePath: root },
      { workspacePath: root, workspaceIdentity: "remote-fixture-identity" },
    ]) {
      const workspace = await service.getSkillReferenceCatalog(target);
      assert.equal(workspace.authority, "workspace");
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["native-fixture"],
      );
      const session = await service.getSkillReferenceCatalog({
        ...target,
        sessionId: "saved-session",
      });
      assert.equal(session.authority, "session");
    }
    const records = (await readFile(requestPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.ok(records.every((record) => record.expectedKey === record.actualKey));
    assert.deepEqual(
      records.map((record) => record.actualKey),
      [root, root, "remote-fixture-identity", "remote-fixture-identity"],
    );
  } finally {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    if (previousIdentity === undefined) delete process.env.ZCODE_WORKSPACE_IDENTITY;
    else process.env.ZCODE_WORKSPACE_IDENTITY = previousIdentity;
    assert.ok(root.startsWith(join(tmpdir(), "omp-workspace-id-")));
    await rm(root, { recursive: true, force: true });
  }
});
