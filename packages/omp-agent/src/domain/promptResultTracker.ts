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
      // execute_command 仅项目模式出现（严格分发的本地命令同样可能异步收口）。
      // 修复（G11）：移除 follow_up 登记——已核对真实 omp（rpc-session-host.ts /
      // rpc-prompt-results.ts）：steer/follow_up 从不开 prompt ticket、永不发
      // prompt_result；登记其 response 只会让 id 滞留本集合泄漏。
      (frame.command === "prompt" || frame.command === "execute_command") &&
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
