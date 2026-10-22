import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { installPreloadMainWorldScript } from "./mainWorld.js";

const electron = vi.hoisted(() => ({
  contextBridge: { executeInMainWorld: undefined as undefined | Mock },
  webFrame: { executeJavaScript: vi.fn() },
}));
vi.mock("electron", () => electron);
afterEach(() => {
  electron.contextBridge.executeInMainWorld = undefined;
  vi.clearAllMocks();
});

describe("preload main-world installation", () => {
  it("keeps the native bridge path unchanged when available", () => {
    electron.contextBridge.executeInMainWorld = vi.fn();
    const script = { func: () => undefined, args: ["page"] };
    installPreloadMainWorldScript(script);
    expect(electron.contextBridge.executeInMainWorld).toHaveBeenCalledWith(script);
    expect(electron.webFrame.executeJavaScript).not.toHaveBeenCalled();
  });

  it("installs a page-owned callback and cancellation without exposing an evaluator", () => {
    const listeners = new Map<string, (value: string) => void>();
    const page: Record<string, unknown> = {
      addEventListener: (name: string, handler: (value: string) => void) =>
        listeners.set(name, handler),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    electron.webFrame.executeJavaScript.mockImplementation((source: string) => {
      runInNewContext(source, { window: page });
      return Promise.resolve();
    });
    const eventName = 'locale-";</script>';
    installPreloadMainWorldScript({
      func: (name: string) => {
        Object.defineProperty(window, "subscribe", {
          value: (callback: EventListener) => {
            window.addEventListener(name, callback);
            return () => window.removeEventListener(name, callback);
          },
        });
      },
      args: [eventName],
    });
    const callback = vi.fn();
    const cancel = (page.subscribe as (listener: Mock) => () => void)(callback);
    listeners.get(eventName)?.("en-US");
    expect(callback).toHaveBeenCalledWith("en-US");
    cancel();
    expect(listeners.size).toBe(0);
    expect(page.eval).toBeUndefined();
    expect(page.executeJavaScript).toBeUndefined();
  });
});
