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
      { name: "beta", scope: "project", enabled: true, transport: "http" },
      { name: "alpha", scope: "profile", enabled: false, transport: "stdio" },
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
        { name: "blocked", enabled: false },
        { name: "localOff", enabled: false },
        { name: "forced", enabled: true },
      ],
    );
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("profile 和项目仅有兼容 MCP 文件时仍展示名称、来源与禁用状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(workspacePath, ".omp"), { recursive: true });
    await writeFile(
      join(agentDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          profileCompat: {
            command: "private-command",
            args: ["private-argument"],
            env: { TOKEN: "private-token" },
          },
        },
      }),
    );
    await writeFile(
      join(workspacePath, ".omp", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          projectCompat: { type: "sse", url: "https://private.example", enabled: false },
        },
      }),
    );
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(snapshot.mcpServers, [
      { name: "projectCompat", scope: "project", enabled: false, transport: "sse" },
      { name: "profileCompat", scope: "profile", enabled: true, transport: "stdio" },
    ]);
    assert.deepEqual(snapshot.configErrors, []);
    assert.equal(snapshot.connectionStatus, "unavailable");
    assert.ok(!JSON.stringify(snapshot).includes("private-"));
    assert.ok(!JSON.stringify(snapshot).includes("private.example"));
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("共存 MCP 文件按项目主→兼容→profile 主→兼容占名，禁用项不被覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    const projectDir = join(workspacePath, ".omp");
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          all: { command: "project-primary", enabled: false },
          projectOnly: { command: "project-primary" },
        },
      }),
    );
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          all: { url: "https://lower.example" },
          withoutProjectPrimary: { type: "sse", enabled: "FALSE" },
          projectCompatOnly: { type: "sse" },
        },
      }),
    );
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          all: { url: "https://lower.example" },
          withoutProjectPrimary: { url: "https://lower.example" },
          profileCollision: { command: "profile-primary" },
          profileOnly: { command: "profile-primary" },
        },
      }),
    );
    await writeFile(
      join(agentDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          all: { url: "https://lower.example" },
          withoutProjectPrimary: { url: "https://lower.example" },
          profileCollision: { url: "https://lower.example" },
          profileCompatOnly: { url: "https://compat.example" },
        },
      }),
    );
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(snapshot.mcpServers, [
      { name: "all", scope: "project", enabled: false, transport: "stdio" },
      { name: "projectOnly", scope: "project", enabled: true, transport: "stdio" },
      { name: "withoutProjectPrimary", scope: "project", enabled: false, transport: "sse" },
      { name: "projectCompatOnly", scope: "project", enabled: true, transport: "sse" },
      { name: "profileCollision", scope: "profile", enabled: true, transport: "stdio" },
      { name: "profileOnly", scope: "profile", enabled: true, transport: "stdio" },
      { name: "profileCompatOnly", scope: "profile", enabled: true, transport: "http" },
    ]);
    assert.deepEqual(snapshot.configErrors, []);
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("只由 profile 主文件应用跨来源名单，禁用名单胜过强制启用", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(workspacePath, ".omp"), { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        disabledServers: ["blocked"],
        enabledServers: ["blocked", "forced"],
      }),
    );
    await writeFile(
      join(agentDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { profileCompat: { command: "compat", enabled: false } },
        enabledServers: ["profileCompat"],
        disabledServers: ["unaffected"],
      }),
    );
    await writeFile(
      join(workspacePath, ".omp", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          blocked: { command: "blocked", enabled: false },
          forced: { command: "forced", enabled: false },
          unaffected: { command: "unaffected" },
        },
        disabledServers: ["forced", "unaffected"],
        enabledServers: ["profileCompat"],
      }),
    );
    const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(
      snapshot.mcpServers.map(({ name, enabled }) => ({ name, enabled })),
      [
        { name: "blocked", enabled: false },
        { name: "forced", enabled: true },
        { name: "unaffected", enabled: true },
        { name: "profileCompat", enabled: false },
      ],
    );
    assert.deepEqual(snapshot.configErrors, []);
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("缺失 MCP 文件是空状态，读取与解析失败保留其他有效来源并报告错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-native-integrations-"));
  try {
    const agentDir = join(root, "agent");
    const workspacePath = join(root, "workspace");
    const projectDir = join(workspacePath, ".omp");
    const missing = await readOmpNativeIntegrations({ agentDir, workspacePath });
    assert.deepEqual(missing.mcpServers, []);
    assert.deepEqual(missing.configErrors, []);
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, ".mcp.json"), { recursive: true });
    await writeFile(
      join(agentDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { validProfile: { command: "secret" } } }),
    );
    await writeFile(
      join(projectDir, "mcp.json"),
      JSON.stringify({ mcpServers: { validProject: { command: "secret" } } }),
    );
    for (const invalid of [
      '{"private-token":',
      "null",
      "[]",
      "42",
      '{"mcpServers":null}',
      '{"mcpServers":[]}',
      '{"mcpServers":{"invalid":"private-token"}}',
    ]) {
      await writeFile(join(agentDir, "mcp.json"), invalid);
      const snapshot = await readOmpNativeIntegrations({ agentDir, workspacePath });
      assert.deepEqual(snapshot.mcpServers, [
        { name: "validProject", scope: "project", enabled: true, transport: "stdio" },
        { name: "validProfile", scope: "profile", enabled: true, transport: "stdio" },
      ]);
      assert.deepEqual(snapshot.configErrors, ["profile", "project"]);
      assert.equal(snapshot.connectionStatus, "unavailable");
      assert.ok(!JSON.stringify(snapshot).includes("private-token"));
    }
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
