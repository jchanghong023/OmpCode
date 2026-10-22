import * as React from "react";

import { cn } from "../lib/utils.js";

type SizedField = HTMLTextAreaElement | HTMLInputElement;

const nativeFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

// Chromium 120 不支持 field-sizing；尺寸仍交给原有 min/max CSS 约束，
// 不给显式 fixed 控件安装测量，也不改变现代 Chromium 的原生路径。
function useContentSizing<T extends SizedField>(ref: React.ForwardedRef<T>) {
  const elementRef = React.useRef<T | null>(null);
  const resizeRef = React.useRef<(() => void) | null>(null);
  const assignRef = React.useCallback(
    (node: T | null) => {
      elementRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  React.useLayoutEffect(() => {
    const element = elementRef.current;
    if (nativeFieldSizing || !element) return;
    const originalHeight = element.style.height;
    const originalWidth = element.style.width;
    const mirror = document.createElement("span");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:fixed;visibility:hidden;white-space:pre;pointer-events:none;";
    let measuring = false;
    const resize = () => {
      if (measuring) return;
      measuring = true;
      try {
        if (
          element.classList.contains("field-sizing-fixed") ||
          !element.classList.contains("field-sizing-content")
        ) {
          element.style.height = originalHeight;
          element.style.width = originalWidth;
          return;
        }
        const computed = getComputedStyle(element);
        if (element instanceof HTMLTextAreaElement) {
          element.style.height = "0px";
          const padding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
          const border =
            parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
          element.style.height = `${element.scrollHeight + (computed.boxSizing === "border-box" ? border : -padding)}px`;
        } else {
          if (!mirror.isConnected) element.ownerDocument.body.appendChild(mirror);
          mirror.style.font = computed.font;
          mirror.style.letterSpacing = computed.letterSpacing;
          mirror.style.textTransform = computed.textTransform;
          mirror.textContent = element.value || element.placeholder || "\u200b";
          const padding = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight);
          const border =
            parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth);
          element.style.width = `${mirror.getBoundingClientRect().width + (computed.boxSizing === "border-box" ? padding + border : 0)}px`;
        }
      } finally {
        measuring = false;
      }
    };
    resizeRef.current = resize;
    // React 的受控更新和直接 value 赋值不一定产生 input 事件；保留其原 setter，
    // 在单个控件上追加尺寸同步，不修改全局 prototype 或监听整个文档。
    const ownValue = Object.getOwnPropertyDescriptor(element, "value");
    const valueDescriptor =
      ownValue ??
      Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      );
    if (valueDescriptor?.get && valueDescriptor.set && valueDescriptor.configurable !== false) {
      Object.defineProperty(element, "value", {
        configurable: true,
        enumerable: valueDescriptor.enumerable,
        get: valueDescriptor.get,
        set(value: string) {
          valueDescriptor.set!.call(this, value);
          resize();
        },
      });
    }
    const reset = () => queueMicrotask(resize);
    element.addEventListener("input", resize);
    element.form?.addEventListener("reset", reset);
    const mutationObserver = new MutationObserver(resize);
    mutationObserver.observe(element, {
      attributes: true,
      attributeFilter: ["class", "placeholder", "rows", "cols"],
    });
    let width = element.getBoundingClientRect().width;
    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    resizeObserver.observe(element);
    const fonts = element.ownerDocument.fonts;
    fonts.addEventListener("loadingdone", resize);
    resize();
    return () => {
      resizeRef.current = null;
      element.removeEventListener("input", resize);
      element.form?.removeEventListener("reset", reset);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      fonts.removeEventListener("loadingdone", resize);
      mirror.remove();
      if (ownValue) Object.defineProperty(element, "value", ownValue);
      else Reflect.deleteProperty(element, "value");
      element.style.height = originalHeight;
      element.style.width = originalWidth;
    };
  }, []);
  React.useLayoutEffect(() => resizeRef.current?.());
  return nativeFieldSizing ? ref : assignRef;
}

export const FieldSizingInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  function FieldSizingInput(props, ref) {
    const sizingRef = useContentSizing(ref);
    return <input {...props} ref={sizingRef} />;
  },
);

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    const sizingRef = useContentSizing(ref);
    return (
      <textarea
        ref={sizingRef}
        data-slot="textarea"
        className={cn(
          "flex field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-input/20 px-2 py-2 text-ui-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-ui-base/relaxed",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
