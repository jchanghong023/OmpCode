import { useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOfflineDataBackupState } from "@/hooks/useOfflineDataBackupState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

function OfflineStateField({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-1 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd
        className={`min-w-0 whitespace-pre-wrap text-ui-base text-foreground [overflow-wrap:anywhere] ${mono ? "font-mono" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}

/** 本页不使用 settingService 的 directoryInfo；远程工作区不能替换本机 Main 的运行事实。 */
export function OmpOfflineDataBackupSection() {
  const { intl, locale } = useZCodeIntl();
  const { status, snapshot, isRefreshing, refresh } = useOfflineDataBackupState();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    [locale],
  );
  const formatTimestamp = (value: string | null) =>
    value ? (
      <time dateTime={value} title={value}>
        {dateFormatter.format(new Date(value))}
      </time>
    ) : (
      intl.formatMessage({ id: "offlineBackup.noRecord" })
    );

  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-5">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "offlineBackup.description" })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={refresh}
          disabled={isRefreshing || status === "unavailable"}
          aria-describedby="offline-backup-refresh-hint"
        >
          <RefreshCw
            className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {intl.formatMessage({ id: "offlineBackup.refresh" })}
        </Button>
      </div>
      <p id="offline-backup-refresh-hint" className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "offlineBackup.refreshHint" })}
      </p>
      <div aria-live="polite" aria-busy={isRefreshing}>
        {status === "loading" ? (
          <p role="status" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "offlineBackup.loading" })}
          </p>
        ) : status === "unavailable" ? (
          <p
            role="status"
            className="rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
          >
            {intl.formatMessage({ id: "offlineBackup.unavailable" })}
          </p>
        ) : status === "error" ? (
          <p
            role="alert"
            className="rounded-xl border border-border bg-surface p-4 text-ui-base text-destructive"
          >
            {intl.formatMessage({ id: "offlineBackup.error" })}
          </p>
        ) : null}
      </div>
      {status === "ready" && snapshot ? (
        <>
          <section className="min-w-0 space-y-3" aria-labelledby="offline-backup-runtime-heading">
            <h2
              id="offline-backup-runtime-heading"
              className="text-ui-base font-semibold text-foreground"
            >
              {intl.formatMessage({ id: "offlineBackup.localRuntime" })}
            </h2>
            <SettingsGroupCard>
              <dl>
                <OfflineStateField label={intl.formatMessage({ id: "offlineBackup.offline" })}>
                  {intl.formatMessage({
                    id: snapshot.offline
                      ? "offlineBackup.offlineEnabled"
                      : "offlineBackup.offlineDisabled",
                  })}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.activeProfile" })}
                  mono
                >
                  {snapshot.activeProfile}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.runtimeRoot" })}
                  mono
                >
                  {snapshot.runtimeRoot}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.persistentRoot" })}
                  mono
                >
                  {snapshot.persistentRoot}
                </OfflineStateField>
                <OfflineStateField label={intl.formatMessage({ id: "offlineBackup.revision" })}>
                  {snapshot.revision.toLocaleString(locale)}
                </OfflineStateField>
              </dl>
            </SettingsGroupCard>
          </section>
          <section className="min-w-0 space-y-3" aria-labelledby="offline-backup-state-heading">
            <h2
              id="offline-backup-state-heading"
              className="text-ui-base font-semibold text-foreground"
            >
              {intl.formatMessage({ id: "offlineBackup.backupState" })}
            </h2>
            <SettingsGroupCard>
              <dl>
                <OfflineStateField label={intl.formatMessage({ id: "offlineBackup.phase" })}>
                  <span className={snapshot.phase === "failed" ? "text-destructive" : undefined}>
                    {intl.formatMessage({ id: `offlineBackup.phase.${snapshot.phase}` })}
                  </span>
                  <p className="mt-1 text-ui-caption text-foreground-subtle">
                    {intl.formatMessage({ id: `offlineBackup.phaseDescription.${snapshot.phase}` })}
                  </p>
                </OfflineStateField>
                <OfflineStateField label={intl.formatMessage({ id: "offlineBackup.period" })}>
                  {intl.formatMessage(
                    { id: "offlineBackup.periodValue" },
                    { milliseconds: snapshot.periodMs.toLocaleString(locale) },
                  )}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.lastAttemptAt" })}
                >
                  {formatTimestamp(snapshot.lastAttemptAt)}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.lastSuccessfulAt" })}
                >
                  {formatTimestamp(snapshot.lastSuccessfulAt)}
                </OfflineStateField>
                <OfflineStateField
                  label={intl.formatMessage({ id: "offlineBackup.nextScheduledAt" })}
                >
                  {snapshot.nextScheduledAt
                    ? formatTimestamp(snapshot.nextScheduledAt)
                    : intl.formatMessage({ id: "offlineBackup.noNextScheduled" })}
                  <p className="mt-1 text-ui-caption text-foreground-subtle">
                    {intl.formatMessage({ id: "offlineBackup.nextHint" })}
                  </p>
                </OfflineStateField>
                <OfflineStateField label={intl.formatMessage({ id: "offlineBackup.code" })} mono>
                  {snapshot.code ?? intl.formatMessage({ id: "offlineBackup.noCode" })}
                </OfflineStateField>
              </dl>
            </SettingsGroupCard>
          </section>
        </>
      ) : null}
      <p className="rounded-xl border border-border bg-surface p-4 text-ui-base leading-6 text-warning">
        {intl.formatMessage({ id: "offlineBackup.risk" })}
      </p>
    </div>
  );
}
