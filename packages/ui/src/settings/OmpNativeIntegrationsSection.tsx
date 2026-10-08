import { useCallback, useEffect, useRef, useState } from "react";
import type { OmpNativeIntegrationSnapshot } from "@zcode/shared/omp-integrations";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Kind = "extension" | "mcp" | "hook";

export interface OmpNativeIntegrationsViewProps {
  kind: Kind;
  title: string;
  description: string;
  snapshot: OmpNativeIntegrationSnapshot | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenDirectory: (path: string) => void;
}

/**
 * omp 原生配置只读视图；目录入口交给系统文件管理器，运行态不伪装成已连接。
 * 与 SkillsSection 的 OmpSkillsCatalogView 同为纯展示测试接缝：数据加载留在 Section。
 */
export function OmpNativeIntegrationsView({
  kind,
  title,
  description,
  snapshot,
  error,
  loading,
  onRefresh,
  onOpenDirectory,
}: OmpNativeIntegrationsViewProps) {
  const { intl } = useZCodeIntl();
  const entries =
    kind === "extension"
      ? snapshot?.extensions
      : kind === "hook"
        ? snapshot?.hooks
        : snapshot?.mcpServers;
  return (
    <section className="flex max-w-3xl flex-col gap-5" data-testid={`omp-native-${kind}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          {/* 原生配置页同样必须随界面字号缩放，不能使用 Tailwind 固定字号。 */}
          <h2 className="text-ui-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-ui-base text-foreground-subtle">{description}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {intl.formatMessage({ id: "settings.ompNative.refresh" })}
        </Button>
      </div>
      {error ? (
        <p className="text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.ompNative.loadFailed" })}: {error}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <p className="rounded-lg border border-border px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id:
                kind === "hook"
                  ? "settings.ompNative.hooksRuntimeUnavailable"
                  : "settings.ompNative.runtimeUnavailable",
            })}
          </p>
          {(["profile", "project"] as const).map((scope) => {
            const path = scope === "profile" ? snapshot.profileDir : snapshot.projectDir;
            if (!path) return null;
            const scoped = entries?.filter((entry) => entry.scope === scope) ?? [];
            const scopeErrorMessageId =
              kind === "hook" && snapshot.hookErrors.includes(scope)
                ? "settings.ompNative.hooksReadFailed"
                : kind === "mcp" && snapshot.configErrors.includes(scope)
                  ? "settings.ompNative.configInvalid"
                  : null;
            return (
              <div key={scope} className="rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground">
                      {intl.formatMessage({ id: `settings.ompNative.${scope}` })}
                    </h3>
                    <p className="break-all font-mono text-ui-base text-foreground-subtle">
                      {path}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenDirectory(path)}
                  >
                    {intl.formatMessage({ id: "settings.ompNative.openDirectory" })}
                  </Button>
                </div>
                {/* 同一来源可同时有有效条目和读取错误；错误不能遮住条目或冒充无配置。 */}
                {scopeErrorMessageId ? (
                  <p className="mt-3 text-ui-base text-destructive">
                    {intl.formatMessage({ id: scopeErrorMessageId })}
                  </p>
                ) : null}
                {scoped.length > 0 ? (
                  <ul className="mt-3 divide-y divide-border">
                    {scoped.map((entry) => (
                      <li
                        key={`${scope}:${entry.name}`}
                        className="flex items-center justify-between gap-2 py-2 text-ui-base"
                      >
                        <span className="truncate text-foreground">{entry.name}</span>
                        <span className="shrink-0 text-foreground-subtle">
                          {"phase" in entry
                            ? String(entry.phase)
                            : "transport" in entry
                              ? `${String(entry.transport)} · ${intl.formatMessage({ id: "enabled" in entry && entry.enabled ? "settings.ompNative.enabled" : "settings.ompNative.disabled" })}`
                              : intl.formatMessage({ id: "settings.ompNative.directoryEntry" })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : scopeErrorMessageId ? null : (
                  <p className="mt-3 text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.ompNative.empty" })}
                  </p>
                )}
              </div>
            );
          })}
        </>
      ) : loading ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.ompNative.loading" })}
        </p>
      ) : null}
    </section>
  );
}

/** 数据加载容器：只负责请求代次隔离与平台读取，展示交给 OmpNativeIntegrationsView。 */
export function OmpNativeIntegrationsSection({
  kind,
  workspacePath,
}: {
  kind: Kind;
  workspacePath?: string;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<OmpNativeIntegrationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setSnapshot(null);
    if (!platform.readOmpNativeIntegrations) {
      setError("unsupported");
      setLoading(false);
      return;
    }
    try {
      const result = await platform.readOmpNativeIntegrations(workspacePath);
      if (requestId.current !== currentRequest) return;
      if (result.success) {
        setSnapshot(result.snapshot);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      if (requestId.current !== currentRequest) return;
      setError("load_failed");
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [platform, workspacePath]);
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  const title = intl.formatMessage({
    id:
      kind === "extension"
        ? "settings.ompNative.extensions"
        : kind === "hook"
          ? "settings.ompNative.hooks"
          : "settings.ompNative.mcp",
  });
  return (
    <OmpNativeIntegrationsView
      kind={kind}
      title={title}
      description={intl.formatMessage({
        id:
          kind === "hook"
            ? "settings.ompNative.hooksDescription"
            : "settings.ompNative.description",
      })}
      snapshot={snapshot}
      error={error}
      loading={loading}
      onRefresh={() => void load()}
      onOpenDirectory={(path) => void platform.openInFileManager(path)}
    />
  );
}
