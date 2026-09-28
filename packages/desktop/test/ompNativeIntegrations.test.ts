import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { readOmpNativeIntegrations } from "../src/main/ompNativeIntegrations.js";

test("只展示 omp 原生扩展和 MCP 名称，不泄露配置值", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(workspacePath, ".omp", "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "sample.ts"), "export default {};\n");
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { alpha: { command: "secret-command", env: { TOKEN: "private-token" } } },
        disabledServers: ["alpha"],
      }),
    );
    await writeFile(
      join(workspacePath, ".omp", "mcp.json"),
      JSON.stringify({
        mcpServers: { beta: { url: "https://private.example/mcp" } },
      }),
    );
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(snapshot.extensions, [{ name: "sample.ts", scope: "profile" }]);
    assert.deepEqual(snapshot.mcpServers, [
      { name: "alpha", scope: "profile", enabled: false, transport: "stdio" },
      { name: "beta", scope: "project", enabled: true, transport: "http" },
    ]);
    assert.ok(!JSON.stringify(snapshot).includes("private-token"));
    assert.ok(!JSON.stringify(snapshot).includes("private.example"));
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP 启用状态遵循 omp 的跨来源名单与 enabled 字段", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(workspacePath, ".omp"), { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { forced: { command: "forced", enabled: false } },
        disabledServers: ["blocked"],
        enabledServers: ["forced"],
      }),
    );
    await writeFile(
      join(workspacePath, ".omp", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          blocked: { command: "blocked" },
          localOff: { command: "localOff", enabled: false },
        },
      }),
    );
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(
      snapshot.mcpServers.map(({ name, enabled }) => ({ name, enabled })),
      [
        { name: "forced", enabled: true },
        { name: "blocked", enabled: false },
        { name: "localOff", enabled: false },
      ],
    );
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("只枚举 profile 与项目 pre/post 中的 JS/TS 钩子文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-hooks-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    await mkdir(join(agentDir, "hooks", "pre"), { recursive: true });
    await mkdir(join(workspacePath, ".omp", "hooks", "post"), { recursive: true });
    await writeFile(join(agentDir, "hooks", "pre", "guard.ts"), "private hook source");
    await writeFile(join(agentDir, "hooks", "pre", "ignored.mjs"), "ignored");
    await writeFile(join(workspacePath, ".omp", "hooks", "post", "notify.js"), "private source");
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(snapshot.hooks, [
      { name: "guard.ts", scope: "profile", phase: "pre" },
      { name: "notify.js", scope: "project", phase: "post" },
    ]);
    assert.deepEqual(snapshot.hookErrors, []);
    assert.ok(!JSON.stringify(snapshot).includes("private hook source"));
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("钩子目录读取失败不被当成空目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-hooks-"));
  try {
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "pre"), "not a directory");
    const snapshot = await readOmpNativeIntegrations({ agentDir: root });
    assert.deepEqual(snapshot.hooks, []);
    assert.deepEqual(snapshot.hookErrors, ["profile"]);
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});
