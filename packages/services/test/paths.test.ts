import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-paths-home-"));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("paths", () => {
  it("应用路径只由启动 OMP 环境确定，不读取上游或旧重定向", async () => {
    const home = makeTempHome();
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
    vi.stubEnv("OMP_CONFIG_ROOT", "");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", join(home, "legacy-target"));
    vi.stubEnv("PI_CONFIG_DIR", join(home, "native-pi"));
    const upstream = join(home, ".zcode", "v2");
    mkdirSync(upstream, { recursive: true });
    const oldSettings = '{"dataBaseDir":"/old","memoryEnabled":true}';
    writeFileSync(join(upstream, "setting.json"), oldSettings);
    // 必须重新加载模块：生产路径在启动导入时固定，不能静态导入后切 HOME。
    vi.resetModules();
    const paths = await import("../src/paths.js");
    const root = join(home, ".ompcode");
    expect(paths.getDataBaseDir()).toBe(root);
    expect(paths.getZCodeDataRootDir()).toBe(root);
    expect(paths.getAppConfigDir()).toBe(join(root, "v2"));
    expect(paths.getConversationWorkspaceDir()).toBe(join(root, "workspace", "default"));
    expect(paths.getTasksIndexDatabasePath()).toBe(join(root, "v2", "tasks-index.sqlite"));
    process.env.OMP_CONFIG_ROOT = join(home, "next");
    expect(paths.getDataBaseDir()).toBe(root);
    expect(readFileSync(join(upstream, "setting.json"), "utf8")).toBe(oldSettings);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(home, "legacy-target"))).toBe(false);
  });

  it("任务索引路径按实际配置根和 profile 隔离且切回稳定", async () => {
    vi.resetModules();
    const { getTasksIndexDatabasePath } = await import("../src/paths.js");
    const configRoot = makeTempHome();
    const first = getTasksIndexDatabasePath({ configRoot, profileId: null });
    const named = getTasksIndexDatabasePath({ configRoot, profileId: "work" });
    const otherRoot = getTasksIndexDatabasePath({ configRoot: makeTempHome(), profileId: null });
    expect(new Set([first, named, otherRoot]).size).toBe(3);
    expect(getTasksIndexDatabasePath({ configRoot, profileId: null })).toBe(first);
    expect(getTasksIndexDatabasePath({ configRoot, profileId: null, authority: "local" })).toBe(
      first,
    );
    const remoteA = getTasksIndexDatabasePath({ configRoot, profileId: null, authority: "host-a" });
    const remoteB = getTasksIndexDatabasePath({ configRoot, profileId: null, authority: "host-b" });
    expect(new Set([first, remoteA, remoteB]).size).toBe(3);
    expect(getTasksIndexDatabasePath({ configRoot, profileId: null, authority: "host-a" })).toBe(
      remoteA,
    );
  });

  it("Windows 数据目录不能选择 ZCode 安装目录或其子目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("c:\\program files\\zcode", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode\\data", {
        platform: "win32",
        env,
      }),
    ).toMatchObject({ ok: false });
  });

  it("Windows 数据目录保护不会误伤同名前缀的普通目录", async () => {
    vi.resetModules();

    const { validateDataBaseDirTarget } = await import("../src/paths.js");
    const env = {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      ZCODE_WINDOWS_APP_INSTALL_DIR: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode",
    };

    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCodeData", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
    expect(
      validateDataBaseDirTarget("C:\\Users\\tester\\Documents\\ZCode", {
        platform: "win32",
        env,
      }),
    ).toEqual({ ok: true });
  });
});
