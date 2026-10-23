import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { OmpConfigurationPanel } from "./OmpConfigurationPanel.js";
import { useOmpModelCatalog, type OmpModelCatalogEntry } from "./ompModelCatalog.js";
import type { IndexPageProps } from "./contract.js";

/** OMP owns the catalog and credentials; this page owns only observation and test feedback. */
export function OmpModelManagementPage({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: IndexPageProps) {
  const { locale, intl } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const { catalog, loading, error } = useOmpModelCatalog(
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  );
  const target = useMemo(
    () => ({ workspacePath, workspaceIdentity }),
    [workspacePath, workspaceIdentity],
  );
  const [sessions, setSessions] = useState<Array<{ sessionId: string }>>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const generation = useRef(0);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      const epoch = ++generation.current;
      setSessions([]);
      setSessionId("");
      setTests({});
      setSessionError(null);
      if (!workspacePath.trim()) return;
      // 目录无需会话；角色配置只允许明确选择已有会话，禁止为管理页创建 dummy session。
      void service
        .listSessions({ ...target, runtimePolicy: "existing-only" })
        .then((items) => {
          if (!disposed && epoch === generation.current) setSessions(items);
        })
        .catch((reason: unknown) => {
          if (!disposed && epoch === generation.current) setSessionError(String(reason));
        });
    };
    refresh();
    const restart = service.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey === resolveWorkspaceKey(target)) refresh();
    });
    const lifecycle = service.onAgentRuntimeLifecycle?.((event) => {
      if (event.workspaceKey !== resolveWorkspaceKey(target)) return;
      if (event.state === "available") refresh();
      else {
        generation.current++;
        setSessions([]);
        setSessionId("");
        setTests({});
      }
    });
    return () => {
      disposed = true;
      generation.current++;
      restart.dispose();
      lifecycle?.dispose();
    };
  }, [service, target, workspacePath]);
  const providers = useMemo(() => {
    const grouped = new Map<string, OmpModelCatalogEntry[]>();
    for (const entry of catalog?.entries ?? []) {
      const group = grouped.get(entry.providerId);
      if (group) group.push(entry);
      else grouped.set(entry.providerId, [entry]);
    }
    return [...grouped.entries()];
  }, [catalog]);
  return (
    <div className="min-w-0 space-y-6" data-testid="omp-native-model-management">
      <p className="text-ui-caption text-foreground-subtle">
        {zh
          ? "模型目录与凭据由当前执行端的 OMP 原生 profile 管理，与同 profile 的 OMP TUI 一致。无需在 GUI 登录或填写模型密钥。"
          : "The execution target's native OMP profile owns models and credentials, matching OMP TUI in the same profile. No model login or API key is required in the GUI."}
      </p>
      {loading && (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {zh ? "正在读取原生模型目录…" : "Loading native model catalog…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-ui-caption text-destructive">
          {zh ? "无法读取 OMP 原生模型目录。" : "Unable to read the native OMP model catalog."}
        </p>
      )}
      {!loading && !error && providers.length === 0 && (
        <p data-testid="omp-native-model-empty" className="text-ui-caption text-foreground-subtle">
          {zh
            ? "当前原生 profile 没有可用模型。请在相同执行端、相同 profile 的 OMP TUI 中检查原生模型配置与认证；返回后目录会自动刷新。"
            : "No models are available in this native profile. Check model configuration and authentication in OMP TUI on the same execution target and profile; the catalog refreshes when you return."}
        </p>
      )}
      {providers.map(([providerId, entries]) => (
        <section
          key={providerId}
          data-testid={`omp-native-provider-${providerId}`}
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          <h3
            data-omp-provider-name={entries[0]?.providerName ?? providerId}
            className="border-b border-border px-4 py-3 text-ui-base font-medium"
          >
            {entries[0]?.providerName ?? providerId}
          </h3>
          {entries.map((entry) => {
            const key = `${entry.providerId}/${entry.modelId}`;
            return (
              <div
                key={key}
                data-testid="omp-native-model-row"
                data-omp-model-provider={entry.providerId}
                data-omp-model-id={entry.modelId}
                data-omp-model-name={entry.modelName}
                data-omp-model-thinking-levels={JSON.stringify(entry.thoughtLevels ?? [])}
                data-omp-model-default-thinking={entry.defaultThoughtLevel ?? ""}
                className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-ui-base font-medium">{entry.modelName}</p>
                  <code className="break-all text-ui-xs text-foreground-subtle">{key}</code>
                  <p className="text-ui-xs text-success">
                    {zh ? "原生凭据已就绪" : "Native credentials ready"}
                  </p>
                  <p className="text-ui-xs text-foreground-subtle">
                    {zh ? "思考等级" : "Thinking levels"}: {entry.thoughtLevels?.join(", ") || "—"}{" "}
                    · {zh ? "默认" : "Default"}: {entry.defaultThoughtLevel ?? "—"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  data-testid="omp-native-model-test"
                  disabled={tests[key] === "pending"}
                  onClick={() => {
                    const epoch = generation.current;
                    setTests((previous) => ({ ...previous, [key]: "pending" }));
                    void service
                      .testModelConnectivity({
                        ...target,
                        selection: { providerId: entry.providerId, modelId: entry.modelId },
                      })
                      .then(() => {
                        if (epoch === generation.current)
                          setTests((previous) => ({
                            ...previous,
                            [key]: zh ? "连接成功" : "Connected",
                          }));
                      })
                      .catch((reason: unknown) => {
                        if (epoch === generation.current)
                          setTests((previous) => ({ ...previous, [key]: String(reason) }));
                      });
                  }}
                >
                  {zh ? "测试连接" : "Test connection"}
                </Button>
                {tests[key] && (
                  <p
                    role="status"
                    data-testid="omp-native-model-test-result"
                    className="w-full break-words text-ui-caption text-foreground-subtle"
                  >
                    {tests[key] === "pending" ? (zh ? "测试中…" : "Testing…") : tests[key]}
                  </p>
                )}
              </div>
            );
          })}
        </section>
      ))}
      <section className="min-w-0 space-y-3">
        <h2 className="text-ui-lg font-semibold">
          {intl.formatMessage({ id: "omp.configuration.persistentRoles" })}
        </h2>
        <p className="text-ui-caption text-foreground-subtle">
          {zh
            ? "请选择已有会话以读取角色、来源和项目覆盖；不会创建新会话。"
            : "Choose an existing session to read roles, sources and project overrides. No session will be created."}
        </p>
        <select
          data-testid="omp-model-role-session"
          aria-label={zh ? "角色配置会话" : "Role configuration session"}
          className="h-9 w-full rounded-md border border-border bg-input px-3 text-ui-base text-foreground"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
        >
          <option value="">{zh ? "选择已有会话" : "Choose an existing session"}</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.sessionId}
            </option>
          ))}
        </select>
        {sessionError && (
          <p role="alert" className="text-ui-caption text-destructive">
            {sessionError}
          </p>
        )}
        {sessionId && (
          <OmpConfigurationPanel
            key={sessionId}
            service={service}
            {...target}
            sessionId={sessionId}
            mode="roles-only"
          />
        )}
      </section>
    </div>
  );
}
