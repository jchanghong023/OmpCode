import type { IFileService } from "@zcode/services";

export interface FileMentionSearchRound {
  didMissRefresh: boolean;
}

export interface FileMentionInputAdmission {
  liveQuery: string;
  roundVersion: number;
}

/** 在真实输入事件中接纳轮次；React 批处理或 deferred 可以跳过中间的空查询。 */
export function createFileMentionInputRounds() {
  let wasEnabled = false;
  let wasEmpty = true;
  let version = 0;
  return {
    admit(query: string, enabled: boolean) {
      const empty = !query.trim();
      if (enabled && (!wasEnabled || (empty && !wasEmpty))) version++;
      wasEnabled = enabled;
      wasEmpty = empty;
      return version;
    },
  };
}

/** 面板仅持有查询轮次，不缓存 Host 索引或文件事实。 */
export async function searchFileMentionEntries(
  service: Pick<IFileService, "searchWorkspaceFiles">,
  params: Parameters<IFileService["searchWorkspaceFiles"]>[0],
  round: FileMentionSearchRound,
  isActive: () => boolean,
) {
  // 清空动作不能等待 RPC 返回：旧空查询若失活，等待后的重置就会丢失新轮次。
  if (!params.query.trim() && isActive()) round.didMissRefresh = false;
  let entries = await service.searchWorkspaceFiles(params);
  if (!isActive()) return entries;
  if (params.query.trim() && entries.length === 0 && !round.didMissRefresh) {
    // 旧代码按每个不同前缀补扫；输入一个不存在的名字会逐字符遍历网络盘。
    // 同轮只补扫一次，Host 仍负责刷新、在途合并、规则失效及索引 TTL。
    round.didMissRefresh = true;
    entries = await service.searchWorkspaceFiles({ ...params, refresh: true });
  }
  return entries;
}
