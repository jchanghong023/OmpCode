// app 层依赖的适配器端口。adapters 层实现；这里只声明接口，保证 app 不碰 IO。

import type {
  OmpCommandFrame,
  OmpConfigUpdateFrame,
  OmpPromptResultFrame,
  OmpSessionEventFrame,
  OmpSessionInfoUpdateFrame,
  OmpSubagentFrame,
} from "../domain/ompFrames.js";
import type {
  OmpAskRequestFrame,
  OmpBypassFrame,
  OmpPermissionRequestFrame,
} from "../domain/ompForkFrames.js";
import type { OmpStateData } from "../domain/ompFrames.js";
import type { OmpContextReport } from "../domain/ompContextReport.js";
export type { OmpStateData };

export interface OmpCommandOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
  /** omp 错误码（响应帧的 code 字段，如 omp_command_failed）；仅失败时由适配器透传。 */
  code?: string;
}

export interface OmpSessionProcess {
  /** omp 会话文件绝对路径（omp 落盘后可用；新会话可能为 null）。 */
  readonly ompSessionFile: string | null;
  /** ready 后 set_subagent_subscription 的事实；旧测试进程可省略。 */
  readonly subagentSubscriptionAvailable?: boolean;
  /** negotiate_protocol v3（fork surface）协商成功的事实；未协商/协商中为 false。 */
  readonly forkSurface?: boolean;
  /** 项目模式通道事实：prompt 默认 text、/xxx 走 execute_command、会话帧按 sessionId 路由。 */
  readonly projectMode?: boolean;
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
}

export interface OmpProcessFactory {
  create(
    options: {
      cwd: string;
      resumeSessionPath?: string;
      onEvent: (event: OmpSessionEventFrame) => void;
      onUiRequest: (request: OmpUiRequest) => void;
      /** v3：结构化工具审批请求（rpc-ui-protocol 4.1）。 */
      onPermissionRequest?: (request: OmpPermissionRequest) => void;
      /** v3：富 ask 答疑请求（rpc-ui-protocol 4.3）。 */
      onAskRequest?: (request: OmpAskRequest) => void;
      onExit: (code: number | null) => void;
    } & OmpSideChannelHandlers,
  ): OmpSessionProcess;
}

/** 会话进程的处理器集合（不含 cwd/resume；项目模式通道与旧进程共用同一形状）。 */
export type OmpSessionProcessHandlers = Omit<
  Parameters<OmpProcessFactory["create"]>[0],
  "cwd" | "resumeSessionPath"
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

/** v3 结构化工具审批请求；应答经同车道旁路帧回传。 */
export interface OmpPermissionRequest {
  frame: OmpPermissionRequestFrame;
  respond(response: OmpBypassFrame): void;
}

/** v3 富 ask 请求；pause 幂等暂停服务端倒计时。 */
export interface OmpAskRequest {
  frame: OmpAskRequestFrame;
  respond(response: OmpBypassFrame): void;
  pause(): void;
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

/** omp 反向 UI 请求经宿主呈现的应答；content 无损承载多题 answers/annotations。 */
export type HostUserInputAnswer =
  | { action: "accept"; optionId?: string; freeText?: string; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** 宿主权限反向请求（interaction/requestPermission）的应答。 */
export type HostPermissionAnswer = {
  decision: "allow" | "deny" | "escalate" | "modify";
  reason?: string;
};

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
  /** 反向请求 interaction/requestPermission，等待宿主应答；缺省实现可省略（走 v4 resolveInteraction）。 */
  requestPermission?(params: {
    requestId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    reason: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    input: unknown;
    origin?: unknown;
    options: {
      optionId: string;
      kind: string;
      name: string;
      description?: string;
      response: unknown;
    }[];
  }): Promise<HostPermissionAnswer>;
}

/** 项目模式会话摘要（app 层消费的字段；完整形状见 domain/ompProjectFrames）。 */
export interface OmpProjectSessionSummaryPort {
  readonly sessionId: string;
  readonly name?: string;
  readonly sessionFile?: string;
  readonly sessionGeneration?: string;
}

/**
 * 项目模式可用性三态：available = 项目进程可用；unsupported = ready 未声明项目模式
 * （旧核，本进程生命周期内不会变化，永久回落）；unavailable = 启动失败/退避窗口中
 * （可重试，与「核本身不支持」必须区分，供调用方决定报错语义与重试策略）。
 */
export type OmpProjectAvailability = "available" | "unsupported" | "unavailable";

/**
 * OMP 项目模式网关端口（实现 = adapters/ompProjectGateway.ts）。app 层经此消费进程
 * 生命周期与会话通道，不直接依赖适配层；omp 未提供项目模式时 available() 为 false，
 * 调用方整体回落「每会话一进程」旧拓扑。
 */
export interface OmpProjectGatewayPort {
  available(): Promise<boolean>;
  /** 三态可用性：区分「旧核永久不支持」与「进程暂时不可用（可重试）」。 */
  availability(): Promise<OmpProjectAvailability>;
  createSession(params: { name?: string }): Promise<OmpProjectSessionSummaryPort>;
  resumeSession(sessionId: string): Promise<OmpProjectSessionSummaryPort>;
  deleteSession(sessionId: string): Promise<OmpCommandOutcome>;
  sendProject(command: unknown): Promise<OmpCommandOutcome>;
  acquireSessionChannel(
    sessionId: string,
    handlers: OmpSessionProcessHandlers,
  ): Promise<OmpSessionProcess>;
  dispose(): Promise<void>;
}
