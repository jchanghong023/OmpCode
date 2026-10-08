import { useCallback, useRef } from "react";

/** 稳定事件入口在触发时读取当前 pane 闭包，避免 snapshot 更新击穿 Composer memo。 */
export function useComposerCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const current = useRef(callback);
  current.current = callback;
  return useCallback((...args: Args) => current.current(...args), []);
}
