import type { OpenSelectionSideChatRequest } from "./workspaceSidePane.js";

// 只传 UI tab 身份，不存模型运行状态或历史。
const listeners = new Set<(request: OpenSelectionSideChatRequest) => void>();
export function openSavedSidePane(request: OpenSelectionSideChatRequest): void {
  for (const listener of listeners) listener(request);
}
export function subscribeSavedSidePanes(
  listener: (request: OpenSelectionSideChatRequest) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
