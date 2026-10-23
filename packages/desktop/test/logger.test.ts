import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("desktop main logger", () => {
  let stdoutListeners = new Set<unknown>();
  let stderrListeners = new Set<unknown>();
  beforeEach(() => {
    stdoutListeners = new Set(process.stdout.listeners("error"));
    stderrListeners = new Set(process.stderr.listeners("error"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const listener of process.stdout.listeners("error")) {
      if (!stdoutListeners.has(listener)) process.stdout.off("error", listener);
    }
    for (const listener of process.stderr.listeners("error")) {
      if (!stderrListeners.has(listener)) process.stderr.off("error", listener);
    }
    const services = await import("@zcode/services/node");
    services.resetProcessFsFaultInjectorForTests();
    services.setDataBaseDir(null);
    vi.resetModules();
  });

  it("swallows injected append faults for main and dedicated log files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-fault-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);
      services.setFsFaultInjectorForTests(
        services.createFsFaultInjector([
          {
            id: "D05-desktop-main-log-append-enospc",
            code: "ENOSPC",
            maxMatches: 0,
            operations: ["appendFile"],
            pathEndsWith: ".log",
          },
        ]),
      );

      const { logger, webRemoteControlRelayLogger } = await import("../src/main/logger.js");

      expect(() => logger.info("main log append fault")).not.toThrow();
      expect(() => webRemoteControlRelayLogger.warn("relay log append fault")).not.toThrow();

      const logDir = join(tempRoot, ".zcode", "v2", "logs");
      await expect(readdir(logDir)).resolves.toEqual(["web-remote-control"]);
      await expect(readdir(join(logDir, "web-remote-control"))).resolves.toEqual([]);

      expect(services.getProcessFsFaultInjector().getHits()).toMatchObject([
        {
          code: "ENOSPC",
          id: "D05-desktop-main-log-append-enospc",
          operation: "appendFile",
        },
        {
          code: "ENOSPC",
          id: "D05-desktop-main-log-append-enospc",
          operation: "appendFile",
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves file logs after console EBADF", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-output-"));
    const failure = Object.assign(new Error("output descriptor unavailable"), { code: "EBADF" });
    vi.spyOn(console, "log").mockImplementation(() => {
      throw failure;
    });
    try {
      // logger 加载时绑定 stream 并解析日志目录，必须在设置隔离目录后重新加载。
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);
      const { logger } = await import("../src/main/logger.js");

      expect(() => logger.info("retained info")).not.toThrow();
      const logDir = join(tempRoot, ".zcode", "v2", "logs");
      const files = await readdir(logDir);
      const contents = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
      expect(contents.join("")).toContain("retained info");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
