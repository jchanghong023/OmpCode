import { createContext, useContext, type ReactNode } from "react";

// 旧版组件仍通过这个上下文接收购买回调；CentOS 7 发行版不提供账户和购买服务。
interface UpgradeTarget {
  providerId: string;
  funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext;
}

const inventory = { entryPlanList: "", status: "ready" as const, retry: () => {} };
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
