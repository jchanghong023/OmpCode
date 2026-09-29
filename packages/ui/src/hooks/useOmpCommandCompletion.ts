import { useEffect, useRef, useState } from "react";
import type { ZCodeOmpCommandCompletionItem } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface OmpCommandCompletionState {
  items: ZCodeOmpCommandCompletionItem[];
  loading: boolean;
}

interface UseOmpCommandCompletionOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId?: string | null;
  /** 正在编辑的完整命令文本（以 `/` 开头，含参数）。 */
  text: string | null;
  enabled: boolean;
}

const EMPTY: OmpCommandCompletionState = { items: [], loading: false };

/**
 * Fork（omp-project-mode.md）：OMP 项目模式动态命令补全（complete_command）。
 * 无执行副作用；调用方按输入丢弃过期响应。能力缺失（旧核/远端不支持）时返回空表，
 * 面板回落本地目录过滤，不报错打断输入。
 */
export function useOmpCommandCompletion(
  options: UseOmpCommandCompletionOptions,
): OmpCommandCompletionState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.remoteSessionId,
    options.workspaceIdentity,
  );
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const [state, setState] = useState<OmpCommandCompletionState>(EMPTY);
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = options.text;
  const enabled = options.enabled && text !== null && text.startsWith("/");
  const remoteSessionId = resolution.remoteSessionId ?? options.remoteSessionId;

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!enabled || !rpcReady || !text) {
      const seq = ++seqRef.current;
      void seq;
      setState(EMPTY);
      return;
    }
    const seq = ++seqRef.current;
    setState((current) => ({ ...current, loading: true }));
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      services.zcodeAgentService
        .completeOmpCommand({
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          text,
          cursor: text.length,
        })
        .then((result) => {
          if (seq !== seqRef.current) return;
          setState({ items: result.items ?? [], loading: false });
        })
        .catch((error: unknown) => {
          if (seq !== seqRef.current) return;
          // 能力缺失是合法回落（旧核 -32601）；其余仅记录，不打断输入。
          const message = error instanceof Error ? error.message : String(error);
          logger.debug("[useOmpCommandCompletion] 动态补全不可用", { error: message });
          setState({ items: [], loading: false });
        });
    }, 120);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [
    enabled,
    rpcReady,
    services,
    text,
    options.workspacePath,
    options.workspaceIdentity,
    options.sessionId,
    remoteSessionId,
  ]);

  return state;
}

/** 候选去重键：完整命令文本（insertText）。 */
export function ompCompletionDedupeKey(item: ZCodeOmpCommandCompletionItem): string {
  return item.insertText;
}
