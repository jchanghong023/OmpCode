import type { PreloadMainWorldInstaller } from "./contract.js";

/** 固定函数在页面世界创建事件订阅；回调与取消函数留在同一世界。 */
export function installPreloadEventBridgeExample(install: PreloadMainWorldInstaller): void {
  install({
    func: (eventName: string) => {
      Object.defineProperty(window, "preloadContractExample", {
        value: {
          subscribe(callback: EventListener) {
            window.addEventListener(eventName, callback);
            return () => window.removeEventListener(eventName, callback);
          },
        },
      });
    },
    args: ["preload-contract-example"],
  });
}
