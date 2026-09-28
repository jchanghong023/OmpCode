import * as React from "react";

import { cn } from "../lib/utils.js";
import { useTextareaAutosize, useTextareaAutosizeValueEffect } from "../../lib/textareaAutosize.js";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, onChange, value, ...props }, forwardedRef) {
    // Chromium 120（CentOS 7 发布运行时）不支持 field-sizing，textarea 会退化成固定
    // min 高度、内部滚动；这里在不支持的运行时用 JS 自适应补齐，保证两平台交互一致
    // （docs/electron-44-28-api-compat.md）。支持的 Chromium 上为 no-op，不覆盖原生行为。
    const { attachRef, resize } = useTextareaAutosize(forwardedRef);
    useTextareaAutosizeValueEffect(value, resize);
    return (
      <textarea
        ref={attachRef}
        data-slot="textarea"
        className={cn(
          "flex field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-input/20 px-2 py-2 text-ui-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-ui-base/relaxed",
          className,
        )}
        onChange={(event) => {
          onChange?.(event);
          resize();
        }}
        value={value}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
