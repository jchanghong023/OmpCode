// ConversationEngine 的构造参数类型（从 conversationEngine.ts 拆出，架构 max-file-lines）。
// 泛型 TEngine 只用于 onIndexChange 回调类型，不反向导入引擎（避免循环依赖）。

import type { HostGateway, OmpProcessFactory } from "./ports.js";
import type { SlashCommandResolver } from "./ompPromptDispatch.js";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";

export interface EngineInit<TEngine = unknown> {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  ompFactory?: OmpProcessFactory;
  gateway: HostGateway;
  onIndexChange: (engine: TEngine) => void;
  /** omp 命令目录热更新出口（available_commands_update 原始命令数组）。 */
  onCommandsUpdate?: (commands: unknown) => void;
  /** 当前进程已收到的独立 command_output 的 GUI 历史派生出口。 */
  onCommandOutput?: (record: OmpCommandOutputRecord, sessionPath: string | null) => Promise<void>;
  /** 关闭/删除前等待派生历史写入；不等待或重发任何 OMP 业务命令。 */
  flushCommandOutputs?: () => Promise<void>;
  resumeSessionPath?: string;
  initialTitle?: string;
  /** 斜杠命令目录解析器（工作区目录进程 v3 富目录；严格分发见 ompPromptDispatch）。 */
  resolveSlashCommand?: SlashCommandResolver;
  /** 原始子代理帧旁路出口（只读详情视图的实时事件源）；帧仍照常进入本引擎投影。 */
  forwardSubagentFrame?: (frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void;
  /**
   * 子代理只读详情的 UI 地址构建器（透传给 ConversationProjection）。缺省用
   * buildOmpSubagentViewId（omp-subagent:<id>@<session>）；SubagentViewStore 承接
   * @parent 地址订阅后 UI 可下钻只读详情。
   */
  viewIdOf?: (subagentId: string) => string;
}
