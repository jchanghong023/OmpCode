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
 * 无执行副作用；调用方按输入丢弃过期响应。能力缺失（旧核/远端不支持，-32601
 * "not supported by omp core"）时记入 ref，后续 Effect 跳过请求（loading 不再置真），
 * 返回空表，面板回落本地目录过滤，不报错打断输入。
 * 项目进程暂时不可用（启动失败/退避，omp-agent 报 -32000 "omp project process
 * unavailable"）不记忆：与旧核的永久缺失不同，下一次输入会在退避窗口后重试。
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
  // 能力缺失记忆：避免旧核每键一次注定失败的 RPC 与空面板闪烁；换工作区/远端会话/服务后重置。
  const capabilityMissingRef = useRef(false);
  const text = options.text;
  const enabled = options.enabled && text !== null && text.startsWith("/");
  const remoteSessionId = resolution.remoteSessionId ?? options.remoteSessionId;

  // workspaceKey（workspacePath + workspaceIdentity）、remoteSessionId 或 services 变化时
  // 重置能力缺失记忆：新目标可能支持 complete_command。
  useEffect(() => {
    capabilityMissingRef.current = false;
  }, [services, remoteSessionId, options.workspacePath, options.workspaceIdentity]);

  // agent runtime 重建后（omp-agent 进程重启/换核）能力事实可能变化，旧核时期记下的
  // 能力缺失不再成立；对齐 useSkills 的 onAgentRuntimeRestarted 失效模式。
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  useEffect(() => {
    if (typeof services.zcodeAgentService.onAgentRuntimeRestarted !== "function") return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      capabilityMissingRef.current = false;
    });
    return () => subscription.dispose();
  }, [services, workspaceKey]);

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
    // 能力缺失（旧核）后跳过请求：loading 不置真，面板回落本地目录过滤。
    if (capabilityMissingRef.current) {
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
          // 能力缺失是合法回落（旧核 -32601）；记入 ref 跳过后续请求。其余仅记录，不打断输入。
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("not supported by omp core")) {
            capabilityMissingRef.current = true;
          }
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
