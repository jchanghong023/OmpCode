import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOmpCodeDataRoot } from "@zcode/shared/node";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ompcode-root-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
  vi.stubEnv("OMP_CONFIG_ROOT", "");
  vi.stubEnv("PI_CONFIG_DIR", join(home, "pi-only"));
  vi.stubEnv("ZCODE_DATA_BASE_DIR", join(home, "obsolete-redirect"));
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(home, { recursive: true, force: true });
});

async function bootstrap(root?: string) {
  if (root !== undefined) vi.stubEnv("OMP_CONFIG_ROOT", root);
  // 模块加载边界测试：静态导入会在 fixture 环境建立前捕获真实启动根。
  vi.resetModules();
  const { applyEarlyDataBaseDirBootstrap } =
    await import("../src/main/desktopDataBaseDirBootstrap.js");
  return applyEarlyDataBaseDirBootstrap();
}

describe("desktopDataBaseDirBootstrap", () => {
  it("uses only valid absolute OMP_CONFIG_ROOT and expands home without mutating OMP env", async () => {
    expect(await bootstrap()).toBe(join(home, ".ompcode"));
    for (const invalid of ["", "  ", "relative/root", "bad\0path"]) {
      expect(await bootstrap(invalid)).toBe(join(home, ".ompcode"));
    }
    const root = join(home, "native-omp");
    expect(await bootstrap(` ${root} `)).toBe(`${root}_ompcode`);
    expect(process.env.OMP_CONFIG_ROOT).toBe(` ${root} `);
    expect(await bootstrap("~/native-omp")).toBe(`${root}_ompcode`);
    expect(resolveOmpCodeDataRoot({ HOME: home, PI_CONFIG_DIR: root })).toBe(
      join(home, ".ompcode"),
    );
  });

  it("round-trips two real roots without importing upstream settings or allowing directory mutation", async () => {
    const upstream = join(home, ".zcode", "v2");
    await mkdir(upstream, { recursive: true });
    const upstreamSettings = JSON.stringify({
      recentProjects: ["/upstream-only"],
      dataBaseDir: join(home, "legacy-target"),
    });
    await writeFile(join(upstream, "setting.json"), upstreamSettings);
    await writeFile(join(upstream, "sentinel"), "untouched");
    const roots = [join(home, "omp-a"), join(home, "omp-b")];
    for (const [index, root] of roots.entries()) {
      expect(await bootstrap(root)).toBe(`${root}_ompcode`);
      const { createSettingService } = await import("@zcode/services/node");
      const service = createSettingService();
      expect((await service.get()).recentProjects ?? []).not.toContain("/upstream-only");
      await service.update({ memoryEnabled: index === 0 });
      await expect(service.update({ dataBaseDir: join(home, "forbidden") })).rejects.toThrow(
        "read-only",
      );
      await expect(service.updateDataBaseDir(undefined)).rejects.toThrow("read-only");
    }
    const firstSettings = join(`${roots[0]}_ompcode`, "v2", "setting.json");
    const persisted = JSON.parse(await readFile(firstSettings, "utf8"));
    await writeFile(
      firstSettings,
      JSON.stringify({ ...persisted, dataBaseDir: join(home, "legacy-target") }),
    );
    for (const [index, root] of roots.entries()) {
      await bootstrap(root);
      const { createSettingService } = await import("@zcode/services/node");
      const settings = await createSettingService().get();
      expect(settings).toMatchObject({
        dataBaseDir: `${root}_ompcode`,
        memoryEnabled: index === 0,
      });
    }
    expect(await readFile(join(upstream, "setting.json"), "utf8")).toBe(upstreamSettings);
    expect(await readFile(join(upstream, "sentinel"), "utf8")).toBe("untouched");
    expect((await readdir(upstream)).sort()).toEqual(["sentinel", "setting.json"]);
    expect(await readdir(home)).not.toContain("legacy-target");
    expect(await readdir(home)).not.toContain("obsolete-redirect");
  });
});
