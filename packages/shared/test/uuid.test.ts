import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../src/uuid.js";
import { projectAccessTokenFingerprint } from "../src/project-access-token.js";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  vi.restoreAllMocks();
  if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  else Reflect.deleteProperty(globalThis, "crypto");
});

function setRuntimeCrypto(value: unknown): void {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
}

describe("secure runtime crypto", () => {
  it("Node 入口只在缺少全局 crypto 时安装安全随机源，UUID v7 保留时间戳与随机位", async () => {
    setRuntimeCrypto(undefined);
    vi.resetModules();
    // 此处有意重新加载 Node-only 入口，验证初始化边界而非缓存后的模块。
    await import("../src/node.js");
    expect(globalThis.crypto).toBe(webcrypto);
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("UUID v7 must not use Math.random");
    });
    const now = 1_788_749_627_422;
    const ids = Array.from({ length: 32 }, () => uuidv7(now));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
    }
    expect(random).not.toHaveBeenCalled();
  });

  it("现代 runtime 已有 crypto 时 Node 入口不替换原生对象", async () => {
    setRuntimeCrypto(webcrypto);
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    vi.resetModules();
    // 此处有意重新加载 Node-only 入口，验证缺能力分支不影响现代 runtime。
    await import("../src/node.js");
    expect(Object.getOwnPropertyDescriptor(globalThis, "crypto")).toEqual(originalDescriptor);
  });

  it("PAT 指纹在有无全局 WebCrypto 时保持相同的 UTF-8 SHA-256", async () => {
    const token = "PAT-中文-🔐-\u0000";
    const expected = createHash("sha256").update(token, "utf8").digest("hex");
    setRuntimeCrypto(webcrypto);
    const digest = vi.spyOn(webcrypto.subtle, "digest");
    expect(await projectAccessTokenFingerprint(token)).toBe(expected);
    expect(digest).toHaveBeenCalledOnce();
    setRuntimeCrypto(undefined);
    expect(await projectAccessTokenFingerprint(token)).toBe(expected);
    expect(digest).toHaveBeenCalledOnce();
  });
});
