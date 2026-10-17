import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService, OfflineDataBackupSnapshot } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export interface OfflineDataBackupState {
  status: "loading" | "error" | "unavailable" | "ready";
  snapshot: OfflineDataBackupSnapshot | null;
  error: unknown;
  isRefreshing: boolean;
}

interface StateSource {
  platform: IPlatformService;
  generation: number;
  latest: OfflineDataBackupSnapshot | null;
}

const LOADING_STATE: OfflineDataBackupState = {
  status: "loading",
  snapshot: null,
  error: null,
  isRefreshing: false,
};

/** 仅投影 Main 的内存状态：先订阅再读取，不调度、不扫描目录、不触发备份。 */
export function useOfflineDataBackupState(): OfflineDataBackupState & { refresh: () => void } {
  const platform = usePlatform();
  const sourceRef = useRef<StateSource>({ platform, generation: 0, latest: null });
  // 在 render 阶段就隔离平台切换，避免旧平台在新 effect 建立前回包。
  if (sourceRef.current.platform !== platform) {
    sourceRef.current = { platform, generation: 0, latest: null };
  }
  const source = sourceRef.current;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [state, setState] = useState<{ source: StateSource; value: OfflineDataBackupState }>({
    source,
    value: LOADING_STATE,
  });
  const refresh = useCallback(() => {
    if (sourceRef.current !== source) return;
    setReloadVersion((version) => version + 1);
  }, [source]);

  useEffect(() => {
    const generation = ++source.generation;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let acceptedEvents = 0;
    const isCurrent = () =>
      active && sourceRef.current === source && source.generation === generation;
    const publish = (value: OfflineDataBackupState) => {
      if (isCurrent()) setState({ source, value });
    };
    const fail = (error: unknown, phase: "subscribe" | "read") => {
      if (!isCurrent()) return;
      logger.warn("[offline-backup] Runtime state access failed", {
        event: "offline.backup.state.failed",
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
      publish({
        status: "error",
        snapshot: source.latest,
        error,
        isRefreshing: false,
      });
    };
    const accept = (snapshot: OfflineDataBackupSnapshot) => {
      if (!isCurrent()) return;
      // 迟到快照和乱序事件不能覆盖已经看到的新版本，包括手动重读后的回包。
      if (!source.latest || snapshot.revision > source.latest.revision) {
        source.latest = snapshot;
      }
      publish({ status: "ready", snapshot: source.latest, error: null, isRefreshing: false });
    };

    if (!platform.getOfflineDataBackupState || !platform.onOfflineDataBackupStateChanged) {
      publish({ status: "unavailable", snapshot: null, error: null, isRefreshing: false });
      return () => {
        active = false;
        ++source.generation;
      };
    }

    publish({
      status: source.latest ? "ready" : "loading",
      snapshot: source.latest,
      error: null,
      isRefreshing: true,
    });
    try {
      // 必须先接事件；否则 snapshot 与订阅之间的变化会永久丢失。
      unsubscribe = platform.onOfflineDataBackupStateChanged((snapshot) => {
        if (!isCurrent()) return;
        if (source.latest && snapshot.revision < source.latest.revision) return;
        ++acceptedEvents;
        accept(snapshot);
      });
      const eventsBeforeRead = acceptedEvents;
      void platform.getOfflineDataBackupState().then(
        (snapshot) => accept(snapshot),
        (error: unknown) => {
          // 新事件已经恢复可读状态时，旧请求的错误不能覆盖它。
          if (acceptedEvents === eventsBeforeRead) fail(error, "read");
        },
      );
      logger.debug("[offline-backup] Runtime state subscription established", {
        event: "offline.backup.state.subscribed",
      });
    } catch (error) {
      fail(error, unsubscribe ? "read" : "subscribe");
    }

    return () => {
      // 先作废 generation，再移除监听，防止清理期间或卸载后的异步回包。
      active = false;
      ++source.generation;
      try {
        unsubscribe?.();
      } catch (error) {
        logger.warn("[offline-backup] Runtime state listener cleanup failed", {
          event: "offline.backup.state.unsubscribe.failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }, [platform, source, reloadVersion]);

  return { ...(state.source === source ? state.value : LOADING_STATE), refresh };
}
