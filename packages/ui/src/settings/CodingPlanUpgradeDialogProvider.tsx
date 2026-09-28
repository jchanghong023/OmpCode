import { createContext, useContext, type ReactNode } from "react";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import type { PurchaseAudience } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";

// 旧版组件仍通过这个上下文接收购买回调；CentOS 7 发行版不提供账户和购买服务。
// 修复说明：stub 必须保留上游 CodingPlanUpgradeDialogTarget / CodingPlanEntryInventory
// 的完整字段形状——status 是三态联合而不是恒 "ready"，购买参数声明为可选但被忽略。
// 否则调用方的 loading/error 分支会被 TypeScript 控制流收窄为不可达而编译失败。
interface UpgradeTarget {
  providerId: string;
  initialAudience?: PurchaseAudience;
  initialTeamPlanKey?: string;
  funnelContext?: CodingPlanFunnelContext;
}

interface EntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

const inventory: EntryInventory = { entryPlanList: "", status: "ready", retry: () => {} };
const disabledUpgrade = {
  inventory,
  openCodingPlanUpgrade: (
    _target: UpgradeTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => {
    if (observation && !observation.signal.aborted) observation.onResult(false);
    return false;
  },
};

const Context = createContext<typeof disabledUpgrade | null>(null);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={disabledUpgrade}>{children}</Context.Provider>;
}

export function useCodingPlanUpgradeDialog() {
  const value = useContext(Context);
  if (!value) throw new Error("CodingPlanUpgradeDialogProvider is required");
  return value;
}

export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(Context);
}
