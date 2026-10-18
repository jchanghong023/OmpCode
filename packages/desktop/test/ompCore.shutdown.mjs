/** 正常关闭给 Chromium 落盘机会；调用者始终保留既有强杀兜底。 */
export async function shutdownOwnedGui(runtime, launcher) {
  if (!runtime?.shutdownUrl || launcher.exitCode !== null || launcher.signalCode !== null) return;
  const started = Date.now();
  const log = (event) =>
    console.log(
      `[GUI] stage=${runtime.stageId ?? "standalone"} suite=${runtime.suite ?? "unknown"} phase=${runtime.phase ?? "unknown"} launcherPid=${launcher.pid} electronPid=${runtime.electronPid} ${event}`,
    );
  log(`graceful shutdown begin evidence=${runtime.runRoot}`);
  let timer;
  let onClose;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, 10_000);
  });
  const closed = new Promise((resolve) => {
    onClose = resolve;
    launcher.once("close", onClose);
  });
  try {
    await Promise.race([
      (async () => {
        const response = await fetch(runtime.shutdownUrl, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) await closed;
        else log(`graceful shutdown rejected status=${response.status}`);
      })(),
      deadline,
    ]);
  } catch (error) {
    log(`graceful shutdown request failed type=${error?.name ?? "Error"}`);
  } finally {
    clearTimeout(timer);
    launcher.removeListener("close", onClose);
    log(
      `graceful shutdown ${launcher.exitCode !== null || launcher.signalCode !== null ? "complete" : "fallback required"} elapsedMs=${Date.now() - started} evidence=${runtime.runRoot}`,
    );
  }
}
