// app 层依赖的适配器端口。adapters 层实现；这里只声明接口，保证 app 不碰 IO。

import type {
  OmpCommandFrame,
  OmpExtensionUiResponseFrame,
  OmpSessionEventFrame,
} from "../domain/ompFrames.js";
import type { OmpStateData } from "../domain/ompFrames.js";
export type { OmpStateData };

export interface OmpCommandOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface OmpSessionProcess {
  /** omp 会话文件绝对路径（omp 落盘后可用；新会话可能为 null）。 */
  readonly ompSessionFile: string | null;
  start(): Promise<void>;
  send(command: OmpCommandFrame): Promise<OmpCommandOutcome>;
  respondUi(response: OmpExtensionUiResponseFrame): void;
  /** 拉一次 get_state；进程未就绪或失败返回 null。 */
  refreshState(): Promise<OmpStateData | null>;
  dispose(): Promise<void>;
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

export interface OmpProcessFactory {
  create(options: {
    cwd: string;
    resumeSessionPath?: string;
    onEvent: (event: OmpSessionEventFrame) => void;
    onUiRequest: (request: OmpUiRequest) => void;
    onExit: (code: number | null) => void;
  }): OmpSessionProcess;
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
  /** 读取一个会话文件的原始 JSONL 条目（标题/消息解析在 domain 层）。 */
  readSessionEntries(sessionPath: string): Promise<unknown[]>;
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
