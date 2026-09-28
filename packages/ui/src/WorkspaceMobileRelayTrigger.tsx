import { useState } from "react";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOfflineLock } from "@/lib/offlineLockGate.js";
import { logger } from "@/logger.js";
import { MobileRelayDialog } from "@/MobileRelayDialog.js";

/**
 * 手机远控入口：挂在 sidebar footer，打开内嵌中继的扫码弹层。
 * 上游官方云远控入口（闭源云 relay）已按 FORK.md「上游同步策略与平台范围」在两平台移除，
 * 本组件是手机远控的唯一桌面入口；relay 由桌面 main 进程提供，本组件只负责入口和弹层。
 */
export function WorkspaceMobileRelayTrigger({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  // 离线锁定（CentOS 7 --offline）下 relay 后端关闭；入口两平台保留并呈禁用态
  // 附「离线锁定中已关闭」说明（mobile-relay.md「平台与离线边界」），不隐藏入口。
  const offlineLocked = useOfflineLock();
  const [mobileRelayOpen, setMobileRelayOpen] = useState(false);
  const triggerLabel = intl.formatMessage({ id: "mobileRelay.trigger" });
  return (
    <>
      <ControlHintTooltip
        title={triggerLabel}
        description={offlineLocked ? intl.formatMessage({ id: "offlineLock.disabledHint" }) : undefined}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          // 禁用态用 aria-disabled + 点击短路而非原生 disabled：原生 disabled 不触发
          // hover，用户会看不到「离线锁定中已关闭」的说明（同 V4ComposerCuaEntry 的取舍）。
          aria-disabled={offlineLocked || undefined}
          onClick={() => {
            if (offlineLocked) return;
            logger.info("[WorkspaceMobileRelayTrigger] 打开手机远控弹层");
            setMobileRelayOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={triggerLabel}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            offlineLocked && "opacity-50",
            className,
          )}
        >
          {/* 扫码直达手机 App。 */}
          <QrCode className="size-4 text-foreground-subtle" />
          {compact ? <span className="sr-only">{triggerLabel}</span> : triggerLabel}
        </Button>
      </ControlHintTooltip>
      <MobileRelayDialog open={mobileRelayOpen} onOpenChange={setMobileRelayOpen} />
    </>
  );
}
