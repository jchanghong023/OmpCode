// SessionRegistry 的无状态恢复编排；在途集合仍仅由 Registry 持有，关闭边界仍由 gates 写入。
import type { ConversationEngine } from "./conversationEngine.js";
import type { OmpStoreSessionSummary } from "./ports.js";
import type { SessionRegistryGates } from "./sessionRegistryGates.js";
import { diagnostics } from "./diagnostics.js";

export interface PendingResume {
  promise: Promise<ConversationEngine>;
  closedSessionIds: Set<string>;
}

interface ResumeParams {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
}

/**
 * 恢复会话：冷历史行先行入投影；omp 进程按 --resume 惰性启动。
 * 修复依据：同一会话的并发 resume（如会话创建 ACK 后宿主 readSession 与 task-index 回源
 * 同时到达）会各自构建冷引擎并相互覆盖注册表，把正在运行回合的活引擎顶成 0 行冷引擎，
 * 会话面板因此永久空白（GUI 实测缺陷）。此处按 sessionId 去重并发加载；加载完成后若
 * 已有更早登记的引擎（并发 create 或先完成的加载），一律返回已登记引擎，
 * 丢弃本次冷恢复结果（冷恢复引擎惰性挂载、无子进程，丢弃无副作用）。
 */
export function resumeSessionWith(
  pendingResumes: Map<string, Set<PendingResume>>,
  gates: SessionRegistryGates,
  params: ResumeParams,
  load: (
    params: ResumeParams,
    closedSessionIds: ReadonlySet<string>,
  ) => Promise<ConversationEngine>,
): Promise<ConversationEngine> {
  let pending = pendingResumes.get(params.sessionId);
  if (pending) {
    for (const resume of pending) {
      if (resume.closedSessionIds.size === 0) {
        diagnostics.debug("omp.session.resume.joined", {
          event: "omp.session.resume.joined",
          sessionId: params.sessionId,
          stage: "cold_load",
        });
        return resume.promise;
      }
    }
  } else {
    pending = new Set();
    pendingResumes.set(params.sessionId, pending);
  }
  // 首个 await 前入表，关闭也必须覆盖尚在 create 屏障/alias 查找中的恢复。
  const closedSessionIds = gates.captureResumeClosures();
  const resumes = pending;
  const resume: PendingResume = {
    closedSessionIds,
    promise: load(params, closedSessionIds).finally(() => {
      resumes.delete(resume);
      if (resumes.size === 0) pendingResumes.delete(params.sessionId);
    }),
  };
  resumes.add(resume);
  return resume.promise;
}

export function* pendingResumeClosures(
  pendingResumes: ReadonlyMap<string, ReadonlySet<PendingResume>>,
): Iterable<Set<string>> {
  for (const resumes of pendingResumes.values()) {
    for (const resume of resumes) yield resume.closedSessionIds;
  }
}

export function coldResumeOwner(
  owner: ConversationEngine | null,
  params: { workspaceId: string; workspacePath: string },
  cold: OmpStoreSessionSummary,
): ConversationEngine | null {
  // 根因：旧 GUI alias 仅在存储中识别；canonical 先恢复时另建引擎会争同一原生 lease。
  // 权威摘要证明身份后仍核对 workspace 与文件 epoch，不能仅凭 UUID 复用邻域 owner。
  return owner &&
    (owner.workspaceId.trim() || owner.workspacePath) ===
      (params.workspaceId.trim() || params.workspacePath) &&
    owner.workspacePath === params.workspacePath &&
    owner.ompSessionFile === (cold.sessionPath || null)
    ? owner
    : null;
}
