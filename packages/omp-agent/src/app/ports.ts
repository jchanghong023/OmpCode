// app 层依赖的适配器端口。adapters 层实现；这里只声明接口，保证 app 不碰 IO。

import type {
  OmpAskQuestion,
  OmpCommandFrame,
  OmpConfigUpdateFrame,
  OmpPromptResultFrame,
  OmpSessionEventFrame,
  OmpSessionInfoUpdateFrame,
  OmpSubagentFrame,
} from "../domain/ompFrames.js";
import type { OmpBypassFrame, OmpDirectoryCommand } from "../domain/ompForkFrames.js";
import type { OmpStateData } from "../domain/ompFrames.js";
import type { OmpContextReport } from "../domain/ompContextReport.js";
import type { OmpBtwFrame } from "../domain/OmpBtwFrames.js";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";
export type { OmpStateData };

export interface OmpCommandOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
  /** omp 错误码（响应帧的 code 字段或适配器合成码）；仅失败时由适配器透传。 */
  code?: string;
}

export interface OmpSessionProcess {
  /** omp 会话文件绝对路径（omp 落盘后可用；新会话/目录进程可能为 null）。 */
  readonly ompSessionFile: string | null;
  /** ready 后 set_subagent_subscription 的事实；旧测试进程可省略。 */
  readonly subagentSubscriptionAvailable?: boolean;
  /** negotiate_protocol v3（fork surface）协商成功的事实；未协商/协商中为 false。 */
  readonly forkSurface?: boolean;
  start(): Promise<void>;
  send(command: OmpCommandFrame): Promise<OmpCommandOutcome>;
  respondUi(response: OmpBypassFrame): void;
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
  onBtwFrame?: (frame: OmpBtwFrame) => void;
}

export interface OmpProcessFactory {
  create(
    options: {
      cwd: string;
      resumeSessionPath?: string;
      /** 目录进程：`--mode rpc-ui --no-session`（无会话语义，承载工作区级查询）。 */
      sessionless?: boolean;
      onEvent: (event: OmpSessionEventFrame) => void;
      onUiRequest: (request: OmpUiRequest) => void;
      /** 富 ask 请求（extension_ui_request method:"ask"，set_ask_dialog 启用后下发）。 */
      onAskRequest?: (request: OmpAskRequest) => void;
      onExit: (code: number | null) => void;
    } & OmpSideChannelHandlers,
  ): OmpSessionProcess;
}

/** 会话进程的处理器集合（不含 cwd/resume/sessionless；各进程实现共用同一形状）。 */
export type OmpSessionProcessHandlers = Omit<
  Parameters<OmpProcessFactory["create"]>[0],
  "cwd" | "resumeSessionPath" | "sessionless"
>;

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
    sensitive?: boolean;
  };
  respond(response: OmpBypassFrame): void;
}

/** 富 ask 请求（extension_ui_request method:"ask"）：完整问题集一次下发；应答按题回传。 */
export interface OmpAskRequest {
  frame: {
    id: string;
    questions: OmpAskQuestion[];
    timeoutMs?: number;
  };
  respond(response: OmpBypassFrame): void;
}

export interface OmpStoreSessionSummary {
  sessionId: string;
  sessionPath: string;
  title: string | null;
  firstUserText: string | null;
  updatedAt: number;
  createdAt: number;
  /** 仅有 GUI 命令派生历史；空 sessionPath 不能作为 OMP --resume 路径。 */
  commandOutputOnly?: true;
}

export interface OmpCommandOutputSession {
  cwd: string;
  sessionId: string;
  sessionPath: string | null;
  title?: string;
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
  /** 只保存 GUI 实际收到的本地命令文本，不保存 OMP 模型历史或业务状态。 */
  appendCommandOutput?(
    session: OmpCommandOutputSession,
    record: OmpCommandOutputRecord,
  ): Promise<void>;
  readCommandOutputs?(
    cwd: string,
    sessionId: string,
    sessionPath?: string | null,
  ): Promise<OmpCommandOutputRecord[]>;
  /** 原生文件随后生成时关联其 UUID；不另建 OMP 会话文件。 */
  associateCommandOutputs?(session: OmpCommandOutputSession): Promise<void>;
  deleteCommandOutputs?(
    cwd: string,
    sessionId: string,
    sessionPath?: string | null,
  ): Promise<boolean>;
  flushCommandOutputs?(): Promise<void>;
}

/** omp 反向 UI 请求经宿主呈现的应答；content 无损承载多题 answers/annotations。 */
export type HostUserInputAnswer =
  | { action: "accept"; optionId?: string; freeText?: string; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** v4 userInput 反向请求可携带的富问题集（wire schema zcodeUserInputRequestParamsSchema.questions）。 */
export interface HostUserInputQuestion {
  question: string;
  header: string;
  options: { value: string; label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

export interface HostGateway {
  /** 发送 v4/conversation/frame 通知（params = 物理 wire 帧）。 */
  emitFrame(params: unknown): void;
  /** 反向请求 interaction/requestUserInput，等待宿主应答。 */
  requestUserInput(params: {
    requestId: string;
    sessionId: string;
    prompt: string;
    options?: { optionId: string; label: string }[];
    questions?: HostUserInputQuestion[];
  }): Promise<HostUserInputAnswer>;
}

/**
 * 目录进程 v3 能力可用性三态：available = 目录进程存活且协商 v3（目录命令可用）；
 * unsupported = 旧核（v3 协商失败，进程期内不变，-32601 永久能力缺失）；
 * unavailable = 启动失败/退避窗口（-32000 可重试）。v1 目录查询（模型/命令）不受此判定限制。
 */
export type OmpDirectoryAvailability = "available" | "unsupported" | "unavailable";

/**
 * 目录进程网关端口（实现 = adapters/ompDirectoryGateway.ts）：每 workspace 一个常驻
 * `--mode rpc-ui --no-session` 进程。app 层经此发送工作区级查询（v1）与 v3 目录命令，
 * 不直接依赖适配层。
 */
export interface OmpDirectoryGatewayPort {
  /** v1 目录查询（模型/思考档位/命令目录；任何核可用）。 */
  send(command: OmpCommandFrame): Promise<OmpCommandOutcome>;
  /** v3 目录命令（补全/模型角色/会话目录）；旧核回 code:"omp_capability_missing"。 */
  sendDirectory(command: OmpDirectoryCommand): Promise<OmpCommandOutcome>;
  /** v3 三态可用性：报错语义（永久 -32601 / 暂时 -32000）以此为准。 */
  availability(): Promise<OmpDirectoryAvailability>;
  dispose(): Promise<void>;
}
