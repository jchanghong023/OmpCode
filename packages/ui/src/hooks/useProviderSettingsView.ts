import { useCallback, useSyncExternalStore } from "react";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";

interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

export function useProviderSettingsView(): ProviderSettingsRead {
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] 重试加载根 Environment 失败", { error });
      });
    }, []),
  };
}
