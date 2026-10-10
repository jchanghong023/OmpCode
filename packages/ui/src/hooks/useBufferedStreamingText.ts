import { useEffect, useMemo, useState } from "react";

// 只合并展示值，不能在 transport/store 中丢弃增量或改变 seq。
function createLatestTextBuffer(publish: (text: string) => void, intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = "";
  return {
    push(text: string) {
      latest = text;
      if (timer !== undefined) return;
      // 固定窗口而非 debounce：持续输出时仍定期显示最新正文。
      timer = setTimeout(() => {
        timer = undefined;
        publish(latest);
      }, intervalMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function useBufferedStreamingText(
  text: string,
  streaming: boolean,
  identity: string,
  intervalMs: number,
): string {
  const [shown, setShown] = useState({ identity, text });
  const buffer = useMemo(
    () => createLatestTextBuffer((value) => setShown({ identity, text: value }), intervalMs),
    [identity, intervalMs],
  );
  const immediate =
    intervalMs === 0 ||
    !streaming ||
    identity !== shown.identity ||
    shown.text.length === 0 ||
    !text.startsWith(shown.text);
  useEffect(() => {
    if (intervalMs === 0) {
      buffer.cancel();
      return;
    }
    if (immediate) {
      buffer.cancel();
      if (shown.identity !== identity || shown.text !== text) setShown({ identity, text });
    } else if (shown.text !== text) {
      buffer.push(text);
    }
  }, [buffer, identity, immediate, intervalMs, shown, text]);
  useEffect(() => () => buffer.cancel(), [buffer]);
  // 完成/中止和身份切换在本次 render 就使用真实全文，不能等 effect 或旧 timer。
  return immediate ? text : shown.text;
}
