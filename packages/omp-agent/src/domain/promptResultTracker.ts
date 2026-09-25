import { agentInvokedOf } from "./titleText.js";

/** 只有响应未立即表明 agent 已启动的 prompt 才可能异步本地收口。 */
export class PromptResultTracker {
  private pendingIds = new Set<string>();

  noteResponse(frame: {
    id?: string | null;
    command: string;
    success: boolean;
    data?: unknown;
  }): void {
    if (
      frame.id &&
      (frame.command === "prompt" || frame.command === "follow_up") &&
      frame.success &&
      agentInvokedOf(frame.data) === null
    ) {
      this.pendingIds.add(frame.id);
    }
  }

  shouldFinish(frame: { id?: string; agentInvoked?: boolean }): boolean {
    const matched = frame.id ? this.pendingIds.delete(frame.id) : false;
    return matched && frame.agentInvoked === false;
  }

  clear(): void {
    this.pendingIds.clear();
  }
}
