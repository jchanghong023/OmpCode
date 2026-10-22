import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createHostRawConsole,
  shouldReportHostConsoleError,
  stringifyHostLogArg,
} from "../src/host/hostLog.js";

describe("host log formatting", () => {
  it("serializes Error with message and stack instead of an empty object", () => {
    const error = new Error("Stream closed before handshake completed");

    const text = stringifyHostLogArg(error);

    expect(text).toContain("Stream closed before handshake completed");
    expect(text).toContain("stack");
    expect(text).not.toBe("{}");
  });

  it("Node warning 不应通过 console.error 再上报一条结构化 error", () => {
    expect(
      shouldReportHostConsoleError([
        "(node:71190) ExperimentalWarning: SQLite is an experimental feature",
      ]),
    ).toBe(false);
    expect(shouldReportHostConsoleError(["remote handshake failed"])).toBe(true);
  });
});

describe("host raw console descriptor isolation", () => {
  it.each(["EBADF", "EPIPE"])("keeps structured logging after synchronous %s", (code) => {
    const failure = Object.assign(new Error("stdout unavailable"), { code });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const raw = {
      log: vi.fn(() => {
        throw failure;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const guarded = createHostRawConsole(raw, stdout, stderr);
    const reportHostLog = vi.fn();
    const log = (...args: unknown[]) => {
      guarded.log(...args);
      reportHostLog("info", args);
    };

    expect(() => log("first")).not.toThrow();
    expect(() => log("second")).not.toThrow();
    guarded.warn("stderr is independent");
    expect(raw.log).toHaveBeenCalledTimes(1);
    expect(raw.warn).toHaveBeenCalledWith("stderr is independent");
    expect(reportHostLog.mock.calls).toEqual([
      ["info", ["first"]],
      ["info", ["second"]],
    ]);
  });

  it.each(["EBADF", "EPIPE"])("disables only the failed sink after asynchronous %s", (code) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const raw = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const guarded = createHostRawConsole(raw, stdout, stderr);
    const failure = Object.assign(new Error("stderr unavailable"), { code });

    expect(() => stderr.emit("error", failure)).not.toThrow();
    guarded.warn("unavailable");
    guarded.error("also unavailable");
    guarded.log("stdout is independent");
    expect(raw.warn).not.toHaveBeenCalled();
    expect(raw.error).not.toHaveBeenCalled();
    expect(raw.log).toHaveBeenCalledWith("stdout is independent");
  });

  it.each(["EBADF", "EPIPE"])("isolates synchronous stderr and asynchronous stdout %s", (code) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const failure = Object.assign(new Error("output unavailable"), { code });
    const raw = {
      log: vi.fn(),
      warn: vi.fn(() => {
        throw failure;
      }),
      error: vi.fn(),
    };
    const guarded = createHostRawConsole(raw, stdout, stderr);

    expect(() => guarded.warn("first")).not.toThrow();
    guarded.warn("second");
    guarded.error("same failed stderr");
    expect(raw.warn).toHaveBeenCalledTimes(1);
    expect(raw.error).not.toHaveBeenCalled();
    guarded.log("stdout still works");
    expect(raw.log).toHaveBeenCalledTimes(1);
    expect(() => stdout.emit("error", failure)).not.toThrow();
    guarded.log("stdout now unavailable");
    expect(raw.log).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated synchronous and asynchronous errors", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const failure = Object.assign(new Error("unrelated output failure"), { code: "EIO" });
    const raw = {
      log: vi.fn(() => {
        throw failure;
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const guarded = createHostRawConsole(raw, stdout, stderr);

    expect(() => guarded.log("message")).toThrow(failure);
    expect(() => stdout.emit("error", failure)).toThrow(failure);
    expect(() => stderr.emit("error", failure)).toThrow(failure);
  });
});
