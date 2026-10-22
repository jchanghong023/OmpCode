import { contextBridge, webFrame } from "electron";
import type { TrustedPreloadMainWorldScript } from "./contract.js";

/** 仅供 preload 安装编译期确定的桥；绝不向网页暴露执行源码或传入函数的能力。 */
export function installPreloadMainWorldScript(script: TrustedPreloadMainWorldScript): void {
  if (typeof contextBridge.executeInMainWorld === "function") {
    contextBridge.executeInMainWorld(script);
    return;
  }
  // Electron 28 没有 executeInMainWorld。webFrame 在主世界执行固定的安装函数，
  // 不插入受站点 CSP 限制的 script 标签，也不把 IPC / eval 原语交给不可信网页。
  const source = `(${script.func.toString()})(...${JSON.stringify(script.args ?? [])})`;
  void webFrame.executeJavaScript(source).catch((error: unknown) => {
    console.error("Failed to install preload page bridge", error);
  });
}
