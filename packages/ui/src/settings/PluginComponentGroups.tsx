import type { ZCodePluginComponentKind } from "@zcode/shared";

/** 详情中单个组件项：名称（mono）+ 可选描述（次行）。 */
interface PluginComponentDisplayItem {
  name: string;
  description?: string;
}

/** 一组同类组件：类型 + 权威数量 + 可展示的名称/描述列表。 */
export interface PluginComponentDisplayGroup {
  kind: ZCodePluginComponentKind;
  /** 权威数量：优先取协议计数，缺失时取 items.length。 */
  count: number;
  items: PluginComponentDisplayItem[];
}
