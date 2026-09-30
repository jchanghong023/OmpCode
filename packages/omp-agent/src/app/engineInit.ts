// ConversationEngine 的构造参数类型（从 conversationEngine.ts 拆出，架构 max-file-lines）。
// 泛型 TEngine 只用于 onIndexChange 回调类型，不反向导入引擎（避免循环依赖）。

import type {
  HostGateway,
  OmpProcessFactory,
  OmpSessionProcess,
  OmpSessionProcessHandlers,
} from "./ports.js";

export interface EngineInit<TEngine = unknown> {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  ompFactory?: OmpProcessFactory;
  gateway: HostGateway;
  onIndexChange: (engine: TEngine) => void;
  /** omp 命令目录热更新出口（available_commands_update 原始命令数组）。 */
  onCommandsUpdate?: (commands: unknown) => void;
  resumeSessionPath?: string;
  initialTitle?: string;
  /**
   * 项目模式进程获取器：给出引擎级 handlers（事件/交互/侧信道），返回绑定到共享项目
   * 进程的会话通道。设置后不再使用 ompFactory；进程崩溃后引擎清空 ompProcess，
   * 下一次 ensureOmpStarted 重新获取（网关负责重启进程并 resume 会话）。
   */
  acquireProjectProcess?: (handlers: OmpSessionProcessHandlers) => Promise<OmpSessionProcess>;
  /** 原始子代理帧旁路出口（只读详情视图的实时事件源）；帧仍照常进入本引擎投影。 */
  forwardSubagentFrame?: (frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void;
  /**
   * 子代理只读详情的 UI 地址构建器（透传给 ConversationProjection）。缺省用旧拓扑格式
   * omp-subagent:<id>：旧「每会话一进程」没有 SubagentViewStore 承接 @parent 地址订阅，
   * UI 据此禁用下钻；项目模式显式传 buildOmpSubagentViewId（omp-subagent:<id>@<session>）。
   */
  viewIdOf?: (subagentId: string) => string;
}
