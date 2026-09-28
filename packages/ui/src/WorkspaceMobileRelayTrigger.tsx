import { useState } from "react";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
  const [mobileRelayOpen, setMobileRelayOpen] = useState(false);
  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "mobileRelay.trigger" })}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            logger.info("[WorkspaceMobileRelayTrigger] 打开手机远控弹层");
            setMobileRelayOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "mobileRelay.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* 与 WebRemoteControlTrigger 的 Smartphone 图标区分：扫码直达手机 App。 */}
          <QrCode className="size-4 text-foreground-subtle" />
          {compact ? (
            <span className="sr-only">{intl.formatMessage({ id: "mobileRelay.trigger" })}</span>
          ) : (
            intl.formatMessage({ id: "mobileRelay.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <MobileRelayDialog open={mobileRelayOpen} onOpenChange={setMobileRelayOpen} />
    </>
  );
}
