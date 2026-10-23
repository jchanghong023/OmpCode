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
  it("isolates synchronous EBADF from the remaining output", () => {
    const failure = Object.assign(new Error("stdout unavailable"), { code: "EBADF" });
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
    expect(() => guarded.log("first")).not.toThrow();
    expect(() => guarded.log("second")).not.toThrow();
    guarded.warn("stderr is independent");
    expect(raw.log).toHaveBeenCalledTimes(1);
    expect(raw.warn).toHaveBeenCalledWith("stderr is independent");
  });

  it("disables the failed sink after asynchronous EPIPE", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const raw = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const guarded = createHostRawConsole(raw, stdout, stderr);
    const failure = Object.assign(new Error("stderr unavailable"), { code: "EPIPE" });

    expect(() => stderr.emit("error", failure)).not.toThrow();
    guarded.warn("unavailable");
    guarded.error("also unavailable");
    guarded.log("stdout is independent");
    expect(raw.warn).not.toHaveBeenCalled();
    expect(raw.error).not.toHaveBeenCalled();
    expect(raw.log).toHaveBeenCalledWith("stdout is independent");
  });
});
