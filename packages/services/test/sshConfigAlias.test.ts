import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type * as Os from "node:os";
import type * as ChildProcess from "node:child_process";

const originalHome = process.env["HOME"];
const originalPath = process.env["PATH"];

const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:os");
  vi.doUnmock("node:child_process");
  if (originalHome == null) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }

  if (originalPath == null) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = originalPath;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-ssh-alias-test-"));
  tempDirs.push(homeDir);
  await mkdir(join(homeDir, ".ssh"), { recursive: true });
  // Windows 的 os.homedir() 不由 HOME 决定；统一指向真实临时目录，避免读到用户配置。
  vi.doMock("node:os", async (importOriginal) => ({
    ...(await importOriginal<typeof Os>()),
    homedir: () => homeDir,
  }));
  return homeDir;
}

async function createFakeSshExecutable(homeDir: string, lines: string[]): Promise<string> {
  const binDir = join(homeDir, "bin");
  await mkdir(binDir, { recursive: true });
  const sshPath = join(binDir, "ssh");
  const output = lines.join("\n");
  await writeFile(
    sshPath,
    ["#!/bin/sh", "cat <<'EOF'", output, "EOF", "exit 0", ""].join("\n"),
    "utf8",
  );
  await chmod(sshPath, 0o755);
  return binDir;
}

async function loadAliasParser() {
  const { listSSHConfigAliasesFromLocalConfig } = await import("@zcode/services/node");
  return listSSHConfigAliasesFromLocalConfig;
}

describe("sshConfigAlias fallback parser", () => {
  // Bugfix: pre-push 全量测试并发执行时，动态导入 services/node 会受整体负载影响。
  // 旧的 5s 预算在本地单测能过，但全量 hook 中偶发超时；这里放宽到和 Windows 一致，
  // 让用例仍然捕获真正挂起的问题，同时避免环境负载导致误失败。
  const testTimeout = 15000;

  it(
    "读取单个 alias 并映射到连接表单字段",
    async () => {
      const homeDir = await createTempHome();
      process.env["HOME"] = homeDir;
      process.env["PATH"] = "";

      const configPath = join(homeDir, ".ssh", "config");
      await writeFile(
        configPath,
        [
          "Host dev",
          "  HostName dev.internal",
          "  User root",
          "  Port 2222",
          "  IdentityFile ~/.ssh/id_ed25519",
          "",
        ].join("\n"),
        "utf8",
      );

      const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
      const aliases = await listSSHConfigAliasesFromLocalConfig();

      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        alias: "dev",
        host: "dev.internal",
        username: "root",
        port: 2222,
        source: configPath,
      });
      expect(aliases[0]?.privateKeyPath).toBe(join(homeDir, ".ssh", "id_ed25519"));
    },
    testTimeout,
  );

  it(
    "支持 Include 并过滤不可直接连接的 pattern",
    async () => {
      const homeDir = await createTempHome();
      process.env["HOME"] = homeDir;
      process.env["PATH"] = "";

      const includeDir = join(homeDir, ".ssh", "includes");
      await mkdir(includeDir, { recursive: true });
      await writeFile(
        join(includeDir, "aliases.conf"),
        [
          "Host dev",
          "  HostName dev.example.com",
          "  Port 2201",
          "Host multi one",
          "  HostName invalid.example.com",
          "",
        ].join("\n"),
        "utf8",
      );

      await writeFile(
        join(homeDir, ".ssh", "config"),
        [
          "Include includes/*.conf",
          "Host *",
          "  User default-user",
          "Host skip-*",
          "  HostName wildcard.example.com",
          "Host prod",
          "  HostName prod.example.com",
          "",
        ].join("\n"),
        "utf8",
      );

      const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
      const aliases = await listSSHConfigAliasesFromLocalConfig();
      const aliasNames = aliases.map((item) => item.alias);

      expect(aliasNames).toEqual(["dev", "prod"]);
      expect(aliases[0]).toMatchObject({
        alias: "dev",
        host: "dev.example.com",
        port: 2201,
        username: "default-user",
        source: join(includeDir, "aliases.conf"),
      });
      expect(aliases[1]).toMatchObject({
        alias: "prod",
        host: "prod.example.com",
        username: "default-user",
        source: join(homeDir, ".ssh", "config"),
      });
    },
    testTimeout,
  );

  it(
    "Teleport 通配符 Host 块不会阻断普通 alias 枚举",
    async () => {
      const homeDir = await createTempHome();
      process.env["HOME"] = homeDir;
      process.env["PATH"] = "";

      const configPath = join(homeDir, ".ssh", "config");
      await writeFile(
        configPath,
        [
          "Host *.teleport-*.example.com",
          "  User root",
          "  UserKnownHostsFile /dev/null",
          "",
          "Host *.teleport-bj03.example.com !teleport.example.net",
          "  Port 3022",
          "  ProxyCommand /usr/local/bin/tsh proxy ssh --cluster=teleport-bj03.example.com %r@%h:%p",
          "",
          "Host jump-120",
          "  HostName 172.16.0.11",
          "  User root",
          "",
          "Host ncu",
          "  HostName 10.0.0.103",
          "  User root",
          "  ProxyJump jump-120",
          "",
        ].join("\n"),
        "utf8",
      );

      const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
      const aliases = await listSSHConfigAliasesFromLocalConfig();

      expect(aliases.map((item) => item.alias)).toEqual(["jump-120", "ncu"]);
      expect(aliases[1]).toMatchObject({
        alias: "ncu",
        host: "10.0.0.103",
        username: "root",
        source: configPath,
      });
    },
    testTimeout,
  );

  for (const nativeGlobAvailable of [true, false]) {
    it.skipIf(nativeGlobAvailable && typeof fsPromises.glob !== "function")(
      `${nativeGlobAvailable ? "存在" : "缺少"}原生 glob 时，纯花括号 Include 只读取字面文件`,
      async () => {
        const homeDir = await createTempHome();
        process.env["PATH"] = "";
        vi.doMock("node:fs/promises", async (importOriginal) => {
          const original = await importOriginal<typeof FsPromises>();
          return {
            ...original,
            glob: nativeGlobAvailable ? original.glob : undefined,
          };
        });
        vi.doMock("node:child_process", async (importOriginal) => {
          const original = await importOriginal<typeof ChildProcess>();
          return {
            ...original,
            // Windows 上同步抛错不等价于找不到 ssh；保留真实子进程、流和异步 ENOENT。
            spawn: (_command: string, args: readonly string[], options: ChildProcess.SpawnOptions) =>
              original.spawn(join(homeDir, "missing-ssh-fixture"), args, options),
          };
        });

        const includeDir = join(homeDir, ".ssh", "includes");
        await mkdir(includeDir, { recursive: true });
        const literalPath = join(includeDir, "brace-{one,two}.conf");
        await writeFile(literalPath, "Host literal-brace\n  HostName literal.example\n");
        await writeFile(join(includeDir, "brace-one.conf"), "Host expanded-one\n");
        await writeFile(join(includeDir, "brace-two.conf"), "Host expanded-two\n");
        await writeFile(join(homeDir, ".ssh", "config"), "Include includes/brace-{one,two}.conf\n");

        const listAliases = await loadAliasParser();
        const aliases = await listAliases();
        expect(aliases).toHaveLength(1);
        expect(aliases[0]).toMatchObject({
          alias: "literal-brace",
          host: "literal.example",
          source: literalPath,
        });
      },
      testTimeout,
    );
  }

  // Unix shell 脚本在 Windows 上无法执行（chmod 不生效，ssh 命令不可用），直接跳过
  if (process.platform === "win32") {
    return;
  }

  it("当 ssh -G 只返回默认 identityfile 时不误判为密钥登录", async () => {
    const homeDir = await createTempHome();
    process.env["HOME"] = homeDir;

    const configPath = join(homeDir, ".ssh", "config");
    await writeFile(
      configPath,
      [
        "Host password-host",
        "  HostName password.example.com",
        "  User root",
        "  Port 22",
        "",
      ].join("\n"),
      "utf8",
    );

    const fakeSshPath = await createFakeSshExecutable(homeDir, [
      "hostname password.example.com",
      "port 22",
      "user root",
      "identityfile ~/.ssh/id_rsa",
    ]);
    process.env["PATH"] = fakeSshPath;

    const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
    const aliases = await listSSHConfigAliasesFromLocalConfig();

    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      alias: "password-host",
      host: "password.example.com",
      username: "root",
      port: 22,
      source: configPath,
    });
    expect(aliases[0]?.privateKeyPath).toBeUndefined();
  });

  it(
    "保留 Windows 风格私钥路径中的反斜杠",
    async () => {
      const homeDir = await createTempHome();
      process.env["HOME"] = homeDir;
      process.env["PATH"] = "";

      const configPath = join(homeDir, ".ssh", "config");
      const windowsPrivateKeyPath = "C:\\Users\\alice\\.ssh\\id_ed25519";
      await writeFile(
        configPath,
        [
          "Host windows-host",
          "  HostName windows.example.com",
          "  User root",
          `  IdentityFile ${windowsPrivateKeyPath}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
      const aliases = await listSSHConfigAliasesFromLocalConfig();

      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        alias: "windows-host",
        host: "windows.example.com",
        username: "root",
        source: configPath,
      });
      expect(aliases[0]?.privateKeyPath).toBe(windowsPrivateKeyPath);
    },
    testTimeout,
  );

  it(
    "支持包含反斜杠的 Include 直路径",
    async () => {
      const homeDir = await createTempHome();
      process.env["HOME"] = homeDir;
      process.env["PATH"] = "";

      const includeToken = "includes\\alias.conf";
      const includeFilePath = join(homeDir, ".ssh", includeToken);
      if (process.platform === "win32") {
        await mkdir(join(homeDir, ".ssh", "includes"), { recursive: true });
      }
      await writeFile(
        includeFilePath,
        [
          "Host backslash-include",
          "  HostName include.example.com",
          "  User include-user",
          "",
        ].join("\n"),
        "utf8",
      );

      const rootConfigPath = join(homeDir, ".ssh", "config");
      await writeFile(rootConfigPath, [`Include ${includeToken}`, ""].join("\n"), "utf8");

      const listSSHConfigAliasesFromLocalConfig = await loadAliasParser();
      const aliases = await listSSHConfigAliasesFromLocalConfig();

      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        alias: "backslash-include",
        host: "include.example.com",
        username: "include-user",
        source: includeFilePath,
      });
    },
    testTimeout,
  );
  it(
    "缺少原生 glob 时保留嵌套、字符类、通配模式中的 brace、home token 和去重语义",
    async () => {
      const homeDir = await createTempHome();
      process.env["PATH"] = "";
      vi.doMock("node:fs/promises", async (importOriginal) => ({
        ...(await importOriginal<typeof FsPromises>()),
        glob: undefined,
      }));
      vi.doMock("node:child_process", async (importOriginal) => {
        const original = await importOriginal<typeof ChildProcess>();
        return {
          ...original,
          spawn: (_command: string, args: readonly string[], options: ChildProcess.SpawnOptions) =>
            original.spawn(join(homeDir, "missing-ssh-fixture"), args, options),
        };
      });
      const includeDir = join(homeDir, ".ssh", "includes", "nested");
      await mkdir(includeDir, { recursive: true });
      const aliasesByFile = [
        ["node-a1.conf", "class-match"],
        ["brace-one.conf", "brace-one"],
        ["brace-two.conf", "brace-two"],
        ["home.conf", "home-match"],
      ] as const;
      for (const [filename, alias] of aliasesByFile) {
        await writeFile(join(includeDir, filename), `Host ${alias}\n  HostName ${alias}.example\n`);
      }
      await writeFile(
        join(homeDir, ".ssh", "config"),
        [
          "Include includes/*/node-?[12].conf",
          "Include includes/*/brace-{one,two}.conf",
          "Include ~/.ssh/includes/nested/home.conf",
          "Include %d/.ssh/includes/nested/home.conf",
          "Include includes/missing/*.conf includes/nested",
          "Host root-alias",
          "  HostName root.example",
        ].join("\n"),
      );

      const listAliases = await loadAliasParser();
      const aliases = await listAliases();
      expect(aliases.map((item) => item.alias).sort()).toEqual([
        "brace-one",
        "brace-two",
        "class-match",
        "home-match",
        "root-alias",
      ]);
      expect(aliases.find((item) => item.alias === "class-match")?.source).toBe(
        join(includeDir, "node-a1.conf"),
      );
    },
    testTimeout,
  );

  it(
    "存在原生 glob 时继续使用原生异步迭代",
    async () => {
      const homeDir = await createTempHome();
      process.env["PATH"] = "";
      const includePath = join(homeDir, ".ssh", "native.conf");
      const nativeGlob = vi.fn(async function* (_pattern: string) {
        yield includePath;
      });
      vi.doMock("node:fs/promises", async (importOriginal) => ({
        ...(await importOriginal<typeof FsPromises>()),
        glob: nativeGlob,
      }));
      vi.doMock("node:child_process", async (importOriginal) => {
        const original = await importOriginal<typeof ChildProcess>();
        return {
          ...original,
          spawn: (_command: string, args: readonly string[], options: ChildProcess.SpawnOptions) =>
            original.spawn(join(homeDir, "missing-ssh-fixture"), args, options),
        };
      });
      await writeFile(includePath, "Host native-alias\n  HostName native.example\n");
      await writeFile(join(homeDir, ".ssh", "config"), "Include native*.conf\n");

      const listAliases = await loadAliasParser();
      expect(await listAliases()).toMatchObject([
        { alias: "native-alias", host: "native.example" },
      ]);
      expect(nativeGlob).toHaveBeenCalledOnce();
      expect(nativeGlob).toHaveBeenCalledWith(join(homeDir, ".ssh", "native*.conf"));
    },
    testTimeout,
  );
});
