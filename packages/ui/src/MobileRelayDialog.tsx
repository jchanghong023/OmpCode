import { memo, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileRelayEntryStatus } from "@zcode/shared";
import { Copy, LoaderCircle, QrCode, TriangleAlert, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/** 弹层打开期间轮询入口状态的间隔；只做轻量刷新，不建长连接订阅。 */
const MOBILE_RELAY_POLL_INTERVAL_MS = 5_000;
/** 与 BotsDialog 扫码图一致的最小可扫尺寸；白底由渲染样式保证。 */
const MOBILE_RELAY_QR_WIDTH = 220;

export const MobileRelayDialog = memo(function MobileRelayDialogComponent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [status, setStatus] = useState<MobileRelayEntryStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const loadEntry = useCallback(async () => {
    try {
      const next = await platform.getMobileRelayEntry();
      setStatus(next);
      setLoadError(null);
    } catch (error) {
      // 查询失败保留上一次成功状态，只记录错误提示，避免弹层在轮询抖动时闪断成空态。
      setLoadError(error instanceof Error ? error.message : String(error));
      logger.warn(
        "[MobileRelayDialog] 查询手机远控入口状态失败",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [platform]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadEntry();
    const timer = window.setInterval(() => {
      void loadEntry();
    }, MOBILE_RELAY_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, loadEntry]);

  const relayUrl = status?.running && status.url ? status.url : "";

  useEffect(() => {
    if (!relayUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(relayUrl, {
      margin: 1,
      width: MOBILE_RELAY_QR_WIDTH,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQrDataUrl(null);
          logger.error(
            "[MobileRelayDialog] 生成手机远控入口二维码失败",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);

  const handleCopyUrl = async () => {
    if (!relayUrl) {
      return;
    }
    // 复制走项目统一的 navigator.clipboard 入口（BotsDialog/GitActionMenu 同源），
    // 不可用时给出失败 toast，让用户退回手动选择文本复制。
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "mobileRelay.copyFailed" }));
      return;
    }
    try {
      await navigator.clipboard.writeText(relayUrl);
      toast(intl.formatMessage({ id: "mobileRelay.copied" }));
    } catch (error) {
      logger.warn(
        "[MobileRelayDialog] 复制入口链接失败",
        error instanceof Error ? error.message : String(error),
      );
      toast(intl.formatMessage({ id: "mobileRelay.copyFailed" }));
    }
  };

  const loading = open && !status && !loadError;
  const queryFailed = open && !status && loadError !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-6rem)] max-w-lg gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // Bugfix: 与 WebRemoteControlDialog 一致，弹窗贴近桌面窗口顶部时默认 close 落在
          // Electron drag 区容易点不中，这里显式关闭并标记 no-drag，保证右上角命中。
          className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
        <div className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5">
          <DialogHeader className="space-y-2 pr-8">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <QrCode className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>{intl.formatMessage({ id: "mobileRelay.title" })}</DialogTitle>
                <DialogDescription>
                  {intl.formatMessage({ id: "mobileRelay.description" })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="mt-5 grid gap-4">
            <section className="flex min-h-56 flex-col rounded-xl border border-border bg-card p-4">
              {loading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-ui-base text-foreground-subtle">
                  <LoaderCircle className="size-4 animate-spin" />
                  {intl.formatMessage({ id: "common.loading" })}
                </div>
              ) : queryFailed ? (
                <div className="flex flex-1 flex-col items-start justify-center gap-2">
                  <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                    <TriangleAlert className="size-4 shrink-0 text-warning" />
                    {intl.formatMessage({ id: "mobileRelay.loadFailed" })}
                  </div>
                  {loadError ? (
                    <p className="break-all text-ui-base/relaxed text-foreground-subtle">
                      {loadError}
                    </p>
                  ) : null}
                </div>
              ) : status && !status.running ? (
                <div className="flex flex-1 flex-col items-start justify-center gap-2">
                  <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                    <TriangleAlert className="size-4 shrink-0 text-warning" />
                    {intl.formatMessage({ id: "mobileRelay.notRunning" })}
                  </div>
                  {status.error ? (
                    <p className="break-all text-ui-base/relaxed text-foreground-subtle">
                      {status.error}
                    </p>
                  ) : null}
                </div>
              ) : status ? (
                <div className="flex flex-1 flex-wrap items-start justify-center gap-4">
                  {qrDataUrl ? (
                    /* Bugfix: 深色主题下直接透出二维码会导致深色模块与背景对比不足无法扫码，
                       这里固定白底加内边距，保证任何主题下都可扫。 */
                    <img
                      src={qrDataUrl}
                      alt={intl.formatMessage({ id: "mobileRelay.qrAlt" })}
                      className="size-[220px] shrink-0 rounded-lg border border-border bg-white p-2"
                    />
                  ) : (
                    <div className="flex size-[220px] shrink-0 items-center justify-center rounded-lg border border-border bg-white">
                      <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                    </div>
                  )}
                  <div className="min-w-52 flex-1 space-y-3">
                    <div className="space-y-1.5">
                      <div className="text-ui-base font-medium text-foreground">
                        {intl.formatMessage({ id: "mobileRelay.entryUrl" })}
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1 font-mono text-ui-base text-foreground">
                          {status.url}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          className="shrink-0 enabled:cursor-pointer"
                          aria-label={intl.formatMessage({ id: "mobileRelay.copy" })}
                          onClick={() => {
                            void handleCopyUrl();
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-ui-base">
                        <span className="text-foreground-subtle">
                          {intl.formatMessage({ id: "mobileRelay.connections" })}
                        </span>
                        <span className="font-medium text-foreground">
                          {status.connections}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-ui-base">
                        <span className="text-foreground-subtle">
                          {intl.formatMessage({ id: "mobileRelay.listenPort" })}
                        </span>
                        <span className="font-medium text-foreground">{status.listenPort}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <p className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRelay.note" })}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
