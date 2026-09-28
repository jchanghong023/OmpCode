import { useCallback, useLayoutEffect, useRef, type Ref } from "react";

/**
 * `field-sizing: content` 的 JS 自适应回退。
 *
 * 依据 docs/electron-44-28-api-compat.md：CentOS 7 的 Electron 28 renderer 是
 * Chromium 120，不支持 `field-sizing`（Chromium 123），textarea 会退化成固定
 * min 高度、内部滚动——多行输入属于可见交互降级，违反两平台交互一致性要求。
 *
 * 策略：仅在运行环境确实不支持 `field-sizing` 时启用 JS 自适应；支持的
 * Chromium（Windows 基准）不注入内联 height，避免覆盖原生 field-sizing 行为。
 * 高度上限与内部滚动仍由组件 className 的 max-h / overflow-y 控制。
 */

let fieldSizingSupport: boolean | null = null;

/** 结果按进程缓存：能力检测是纯静态事实，逐次调用 CSS.supports 没有收益。 */
export function supportsCssFieldSizing(): boolean {
  if (fieldSizingSupport === null) {
    fieldSizingSupport =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("field-sizing", "content");
  }
  return fieldSizingSupport;
}

/** 先复位再测量，让 scrollHeight 反映完整内容而不是上一次的行数。 */
export function resizeTextareaToContent(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * textarea 自适应回退的 React 接缝：返回合成 ref（与转发 ref 组合）、
 * 受控值变化效应与非受控输入回调。支持 field-sizing 的环境下全部为 no-op。
 */
export function useTextareaAutosize(forwardedRef?: Ref<HTMLTextAreaElement>): {
  attachRef: (element: HTMLTextAreaElement | null) => void;
  /** 受控 value 变化或非受控输入后调用。 */
  resize: () => void;
} {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const element = innerRef.current;
    if (element && !supportsCssFieldSizing()) {
      resizeTextareaToContent(element);
    }
  }, []);
  const attachRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      innerRef.current = element;
      if (element) {
        resize();
      }
      if (typeof forwardedRef === "function") {
        forwardedRef(element);
      } else if (forwardedRef) {
        (forwardedRef as { current: HTMLTextAreaElement | null }).current = element;
      }
    },
    [forwardedRef, resize],
  );
  return { attachRef, resize };
}

/** 受控 value（或初始 defaultValue）变化后同步高度；非受控场景 value 为 undefined 时跳过。 */
export function useTextareaAutosizeValueEffect(
  value: unknown,
  resize: () => void,
): void {
  useLayoutEffect(() => {
    resize();
  }, [value, resize]);
}
