import { randomBytes } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";

export interface FirstPartyBrowserSnapshotSource {
  readonly session: object;
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

/** 用 Chromium 逻辑 API 导出应用状态；运行中的引擎数据库可能独占锁定，不能复制原始 profile。 */
export async function captureOfflineBrowserState(
  sources: ReadonlyArray<FirstPartyBrowserSnapshotSource>,
  signal: AbortSignal,
  options: {
    relativePath: string;
    timeoutMs?: number;
    cookieSessions?: ReadonlyArray<{ partition: string; session: Pick<Session, "cookies"> }>;
  },
): Promise<Array<{ relativePath: string; content: string }>> {
  if (signal.aborted) throw new Error("offline_browser_state_aborted");
  const liveSources = sources.filter((source) => !source.isDestroyed());
  if (liveSources.length === 0) throw new Error("offline_browser_state_unavailable");
  const identifiedSources = liveSources.map((source) => {
    const url = source.getURL();
    const origin = URL.canParse(url) ? new URL(url).origin : undefined;
    return { source, session: source.session, url, origin: origin === "null" ? undefined : origin };
  });
  // 修复原因：同 session/origin 的窗口共享 localStorage，不能全量跨进程导出后才去重。
  // 仅合并可确认的 origin；opaque/file 等来源仍逐窗读取，避免错误跳过独立存储。
  const seen = new Map<object, Map<string, FirstPartyBrowserSnapshotSource>>();
  const representatives = identifiedSources.filter(({ source, session, origin }) => {
    if (!origin) return true;
    let origins = seen.get(session);
    if (!origins) {
      origins = new Map();
      seen.set(session, origins);
    }
    if (origins.has(origin)) return false;
    origins.set(origin, source);
    return true;
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("offline_browser_state_aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => reject(new Error("offline_browser_state_timeout")),
      options.timeoutMs ?? 5_000,
    );
    timer.unref?.();
  });
  try {
    const [snapshots, cookieSessions] = await Promise.race([
      Promise.all([
        Promise.all(
          representatives.map(async ({ source, origin }) => {
            const snapshot: unknown = await source.executeJavaScript(
              "({ origin: location.origin, localStorage: Object.entries(localStorage) })",
            );
            if (
              origin &&
              (!snapshot ||
                typeof snapshot !== "object" ||
                !("origin" in snapshot) ||
                snapshot.origin !== origin)
            )
              throw new Error("offline_browser_state_changed");
            return snapshot;
          }),
        ),
        Promise.all(
          (options.cookieSessions ?? []).map(async ({ partition, session }) => ({
            partition,
            cookies: (await session.cookies.get({})).filter((cookie) => !cookie.session),
          })),
        ),
      ]),
      interrupted,
    ]);
    // 修复原因：被去重窗口关闭、同源路由/hash 变化不会使已导出的共享存储失效。
    // 只拒绝代表窗口丢失存储身份，或存活的重复窗口进入未导出的域，不能按完整 URL 误拒绝。
    if (
      identifiedSources.some(({ source, session, url, origin }) => {
        // session 必须使用采集前的身份；销毁后的原生 webContents 属性已不可读取。
        const representative = !origin || seen.get(session)?.get(origin) === source;
        if (source.isDestroyed()) return representative;
        const currentUrl = source.getURL();
        if (currentUrl === url) return false;
        if (origin) {
          const currentOrigin = URL.canParse(currentUrl) ? new URL(currentUrl).origin : undefined;
          return representative
            ? currentOrigin !== origin
            : !currentOrigin || !seen.get(session)?.has(currentOrigin);
        }
        // file/opaque 来源不能按 origin 合并；只放行不改变文档的 fragment。
        return currentUrl.split("#", 1)[0] !== url.split("#", 1)[0];
      })
    )
      throw new Error("offline_browser_state_changed");
    const origins = new Map<string, { origin: string; localStorage: Array<[string, string]> }>();
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object")
        throw new Error("offline_browser_state_invalid");
      const { origin, localStorage } = snapshot as { origin?: unknown; localStorage?: unknown };
      if (
        typeof origin !== "string" ||
        !Array.isArray(localStorage) ||
        !localStorage.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string",
        )
      ) {
        throw new Error("offline_browser_state_invalid");
      }
      // All first-party windows share the default session; each origin appears once.
      if (!origins.has(origin)) origins.set(origin, { origin, localStorage });
    }
    return [
      {
        relativePath: options.relativePath,
        content: JSON.stringify({ version: 1, origins: [...origins.values()], cookieSessions }),
      },
    ];
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Keep each app identity's logical state available to subsequent rounds owned by another Main. */
export async function persistOfflineBrowserState(userData: string, content: string): Promise<void> {
  const temporary = join(
    userData,
    `.offline-browser-state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(userData, "first-party-browser-state.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
