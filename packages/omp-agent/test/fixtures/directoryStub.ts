// 测试用目录进程网关桩（OmpDirectoryGatewayPort）。
// 默认行为 = 旧核（v3 能力缺失，code:"omp_capability_missing"），让删除/改名等回落
// 本地文件路径的既有语义可被测试；逐测试注入目录命令行为。

import type {
  OmpCommandFrame,
  OmpCommandOutcome,
  OmpDirectoryGatewayPort,
} from "../../src/app/ports.js";
import type { OmpDirectoryCommand } from "../../src/domain/ompForkFrames.js";

export interface DirectoryStub extends OmpDirectoryGatewayPort {
  /** 已发送的 v1 目录命令（模型/命令目录等）。 */
  readonly sentCommands: OmpCommandFrame[];
  /** 已发送的 v3 目录命令。 */
  readonly sentDirectoryCommands: OmpDirectoryCommand[];
  /** v3 能力事实（false = 旧核能力缺失）。 */
  setForkSurface(value: boolean): void;
}

export function createDirectoryStub(
  handleDirectory: (command: OmpDirectoryCommand) => OmpCommandOutcome = () => ({
    success: false,
    error: "method not supported by omp core",
    code: "omp_capability_missing",
  }),
): DirectoryStub {
  const sentCommands: OmpCommandFrame[] = [];
  const sentDirectoryCommands: OmpDirectoryCommand[] = [];
  let forkSurface = false;
  return {
    sentCommands,
    sentDirectoryCommands,
    setForkSurface(value: boolean) {
      forkSurface = value;
    },
    async send(command: OmpCommandFrame): Promise<OmpCommandOutcome> {
      sentCommands.push(command);
      return { success: true, data: {} };
    },
    async sendDirectory(command: OmpDirectoryCommand): Promise<OmpCommandOutcome> {
      sentDirectoryCommands.push(command);
      if (!forkSurface) {
        return {
          success: false,
          error: `method not supported by omp core: ${command.type}`,
          code: "omp_capability_missing",
        };
      }
      return handleDirectory(command);
    },
    async availability() {
      return forkSurface ? "available" : "unsupported";
    },
    async dispose() {},
  };
}
