import { isApplicationLogLevelEnabled } from "@zcode/shared/log-level";

export function isRendererDebugLoggingEnabled(): boolean {
  const rendererLoggingDisabled =
    (
      globalThis as typeof globalThis & {
        __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean;
      }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ === true;
  return !rendererLoggingDisabled && isApplicationLogLevelEnabled("debug");
}
