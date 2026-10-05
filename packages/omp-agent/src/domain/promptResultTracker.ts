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

  shouldFinish(frame: { id?: string; agentInvoked?: boolean; status?: string }): boolean {
    const matched = frame.id ? this.pendingIds.delete(frame.id) : false;
    // 修复（A1）：新核（v18.4.10+ 输入门）被取消/失败的 prompt 以
    // prompt_result(status=aborted/error, agentInvoked=true) 收尾且无模型回合（响应
    // success 不带 data → 已在本 tracker 登记 id）；此类终态同样需要上抛
    // （onPromptResult）供引擎收口轮次，不能只认 agentInvoked===false。
    return (
      matched &&
      (frame.agentInvoked === false || frame.status === "aborted" || frame.status === "error")
    );
  }

  clear(): void {
    this.pendingIds.clear();
  }
}
