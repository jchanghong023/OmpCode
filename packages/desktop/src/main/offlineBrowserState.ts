import { randomBytes } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";

export interface FirstPartyBrowserSnapshotSource {
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
          liveSources.map((source) =>
            source.executeJavaScript(
              "({ origin: location.origin, localStorage: Object.entries(localStorage) })",
            ),
          ),
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
