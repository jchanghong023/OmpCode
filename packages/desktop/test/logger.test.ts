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

  it.each(["EBADF", "EPIPE"])("preserves file logs after console %s", async (code) => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-output-"));
    const failure = Object.assign(new Error("output descriptor unavailable"), { code });
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {
        throw failure;
      });
    }
    try {
      // logger 加载时绑定 stream 并解析日志目录，必须在设置隔离目录后重新加载。
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);
      const { logger } = await import("../src/main/logger.js");

      expect(() => logger.info("retained info")).not.toThrow();
      expect(() => logger.warn("retained warn")).not.toThrow();
      expect(() => logger.error("retained error")).not.toThrow();
      const logDir = join(tempRoot, ".zcode", "v2", "logs");
      const files = await readdir(logDir);
      const contents = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
      expect(contents.join("")).toContain("retained info");
      expect(contents.join("")).toContain("retained warn");
      expect(contents.join("")).toContain("retained error");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("isolates only descriptor stream errors and preserves unrelated errors", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-stream-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);
      const { logger } = await import("../src/main/logger.js");
      for (const [stream, previous] of [
        [process.stdout, stdoutListeners],
        [process.stderr, stderrListeners],
      ] as const) {
        const listener = stream.listeners("error").find((candidate) => !previous.has(candidate));
        expect(listener).toBeDefined();
        for (const code of ["EBADF", "EPIPE"]) {
          expect(() => listener?.(Object.assign(new Error(code), { code }))).not.toThrow();
        }
        const unrelated = Object.assign(new Error("unrelated stream error"), { code: "EIO" });
        expect(() => listener?.(unrelated)).toThrow(unrelated);
      }
      const unrelated = Object.assign(new Error("unrelated console error"), { code: "EIO" });
      vi.spyOn(console, "log").mockImplementation(() => {
        throw unrelated;
      });
      expect(() => logger.info("must surface")).toThrow(unrelated);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
