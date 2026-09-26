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
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { alpha: { command: "secret-command", env: { TOKEN: "private-token" } } },
      disabledServers: ["alpha"],
    }));
    await writeFile(join(workspacePath, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { beta: { url: "https://private.example/mcp" } },
    }));
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
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { forced: { command: "forced", enabled: false } },
      disabledServers: ["blocked"],
      enabledServers: ["forced"],
    }));
    await writeFile(join(workspacePath, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        blocked: { command: "blocked" },
        localOff: { command: "localOff", enabled: false },
      },
    }));
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(snapshot.mcpServers.map(({ name, enabled }) => ({ name, enabled })), [
      { name: "forced", enabled: true },
      { name: "blocked", enabled: false },
      { name: "localOff", enabled: false },
    ]);
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});
