// app 层依赖的适配器端口。adapters 层实现；这里只声明接口，保证 app 不碰 IO。

import type {
  OmpCommandFrame,
  OmpConfigUpdateFrame,
  OmpExtensionUiResponseFrame,
  OmpPromptResultFrame,
  OmpSessionEventFrame,
  OmpSessionInfoUpdateFrame,
  OmpSubagentFrame,
} from "../domain/ompFrames.js";
import type { OmpStateData } from "../domain/ompFrames.js";
import type { OmpContextReport } from "../domain/ompContextReport.js";
export type { OmpStateData };

export interface OmpCommandOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface OmpSessionProcess {
  /** omp 会话文件绝对路径（omp 落盘后可用；新会话可能为 null）。 */
  readonly ompSessionFile: string | null;
  /** ready 后 set_subagent_subscription 的事实；旧测试进程可省略。 */
  readonly subagentSubscriptionAvailable?: boolean;
  start(): Promise<void>;
  send(command: OmpCommandFrame): Promise<OmpCommandOutcome>;
  respondUi(response: OmpExtensionUiResponseFrame): void;
  /** 拉一次 get_state；进程未就绪或失败返回 null。 */
  refreshState(): Promise<OmpStateData | null>;
  /** 空闲时读取 omp /context；输出由适配器消费，不进入聊天文本。 */
  readContextReport(): Promise<OmpContextReport | null>;
  dispose(): Promise<void>;
}

/** omp 内置命令侧信道回调（全部可选；不关心的事件由适配器丢弃）。 */
export interface OmpSideChannelHandlers {
  /** 本地命令输出（command_output）：按助手文本投影到当前轮。 */
  onCommandOutput?: (frame: { text: string }) => void;
  /** prompt 异步收口：agentInvoked=false 表示本地命令完成、不会再来 agent 事件。 */
  onPromptResult?: (frame: OmpPromptResultFrame) => void;
  /** /title 等命令回投会话元信息。 */
  onSessionInfoUpdate?: (frame: OmpSessionInfoUpdateFrame) => void;
  /** /model、/thinking 等命令回投会话模型配置。 */
  onConfigUpdate?: (frame: OmpConfigUpdateFrame) => void;
  /** 命令目录变化（available_commands_update）。 */
  onCommandsUpdate?: (commands: unknown) => void;
  onSubagentFrame?: (frame: OmpSubagentFrame) => void;
}

export interface OmpProcessFactory {
  create(
    options: {
      cwd: string;
      resumeSessionPath?: string;
      onEvent: (event: OmpSessionEventFrame) => void;
      onUiRequest: (request: OmpUiRequest) => void;
      onExit: (code: number | null) => void;
    } & OmpSideChannelHandlers,
  ): OmpSessionProcess;
}

export interface OmpUiRequest {
  frame: {
    id: string;
    method: string;
    title?: string;
    message?: string;
    prompt?: string;
    placeholder?: string;
    options?: string[];
    optionDetails?: { description?: string }[];
    url?: string;
  };
  respond(response: OmpExtensionUiResponseFrame): void;
}

export interface OmpStoreSessionSummary {
  sessionId: string;
  sessionPath: string;
  title: string | null;
  firstUserText: string | null;
  updatedAt: number;
  createdAt: number;
}

/** omp 会话存储只读访问（~/.omp/agent/sessions/<encoded-cwd>）。 */
export interface OmpStorePort {
  listSessions(cwd: string): Promise<OmpStoreSessionSummary[]>;
  /** 按稳定 ID 定位工作区历史；不受列表展示窗口限制。 */
  findSession?(cwd: string, sessionId: string): Promise<OmpStoreSessionSummary | null>;
  /** 读取一个会话文件的原始 JSONL 条目（标题/消息解析在 domain 层）。 */
  readSessionEntries(sessionPath: string): Promise<unknown[]>;
  /** omp 为 task 子代理在父会话同名目录保存的独立 JSONL。 */
  readSubagentEntries(sessionPath: string, subagentId: string): Promise<unknown[]>;
  deleteSession(sessionPath: string): Promise<boolean>;
}

/** omp 反向 UI 请求经宿主呈现的应答。 */
export type HostUserInputAnswer =
  | { action: "accept"; optionId?: string; freeText?: string }
  | { action: "decline" }
  | { action: "cancel" };

export interface HostGateway {
  /** 发送 v4/conversation/frame 通知（params = 物理 wire 帧）。 */
  emitFrame(params: unknown): void;
  /** 反向请求 interaction/requestUserInput，等待宿主应答。 */
  requestUserInput(params: {
    requestId: string;
    sessionId: string;
    prompt: string;
    options?: { optionId: string; label: string }[];
  }): Promise<HostUserInputAnswer>;
}
