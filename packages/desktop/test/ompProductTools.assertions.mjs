// Keep each function self-contained: the runner serializes it into Electron's renderer.
export async function behaviorAssertions() {
  const f = window.productToolsFixture;
  const check = (value, label) => {
    if (!value) throw new Error(label);
  };
  const tick = () =>
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; ++i) {
      if (predicate()) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(label);
  };
  const state = () => JSON.parse(document.getElementById("hook-state").textContent);
  const snapshot = (revision, phase = "waiting") => ({
    revision,
    phase,
    offline: true,
    activeProfile: `profile-${revision}`,
    runtimeRoot: "/dev/shm/isolated-runtime",
    persistentRoot: "Z:/isolated-persistent",
    periodMs: 60000,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextScheduledAt: null,
    code: null,
  });
  const ready = async (revision, label) =>
    waitFor(() => state().status === "ready" && state().snapshot?.revision === revision, label);
  const refresh = async (id, count) => {
    document.getElementById("hook-refresh").click();
    await waitFor(() => f.stats(id).reads === count, `refresh request ${count} missing`);
  };
  f.reset();
  // Emit synchronously INSIDE the read boundary. Reading before subscription loses this event.
  f.setEventOnRead("A", snapshot(20, "running"));
  f.mount("A");
  await ready(20, "read-boundary event was lost: must subscribe before reading");
  check(f.stats("A").order.join(",") === "subscribe,read", "incorrect subscription/read order");
  f.resolve("A", 0, snapshot(19));
  await tick();
  check(state().snapshot.revision === 20, "late snapshot replaced the newer event");
  f.emit("A", snapshot(18, "failed"));
  await tick();
  check(state().snapshot.phase === "running", "out-of-order event replaced the current revision");
  await refresh("A", 2);
  f.emit("A", snapshot(21, "completed"));
  await ready(21, "new event did not finish refresh");
  f.reject("A", 1);
  await tick();
  check(
    state().status === "ready" && state().snapshot.revision === 21,
    "late reject hid a newer event",
  );

  // Refresh creates a new generation even without changing platform identity.
  await refresh("A", 3);
  await refresh("A", 4);
  f.resolve("A", 2, snapshot(900, "failed"));
  await tick();
  check(
    state().snapshot.revision === 21 && state().isRefreshing,
    "old refresh accepted before the current read",
  );
  f.resolve("A", 3, snapshot(22));
  await ready(22, "current refresh result not accepted");
  check(f.stats("A").listeners === 1 && f.stats("A").removed === 3, "refresh leaked subscriptions");

  await refresh("A", 5);
  f.mount("B");
  await waitFor(() => f.stats("B").reads === 1, "B read missing");
  check(f.stats("A").listeners === 0, "A listener survived platform switch");
  f.mount("A");
  await waitFor(() => f.stats("A").reads === 6, "second A activation read missing");
  check(
    state().status === "loading" && state().snapshot === null,
    "A-B-A reused the first A state",
  );
  f.resolve("A", 4, snapshot(999, "failed"));
  f.reject("B", 0);
  f.emitRemoved("A", snapshot(1000, "failed"));
  f.emitRemoved("B", snapshot(1001, "failed"));
  await tick();
  check(
    state().status === "loading" && state().snapshot === null,
    "A-B-A accepted an old source or removed listener",
  );
  f.resolve("A", 5, snapshot(2));
  await ready(2, "new A source incorrectly inherited the old revision fence");
  check(
    f.stats("B").listeners === 0 && f.stats("A").listeners === 1,
    "platform switch leaked listeners",
  );

  await refresh("A", 7);
  f.unmount();
  check(f.stats("A").listeners === 0, "unmount did not remove listener");
  f.mount("A");
  await waitFor(() => f.stats("A").reads === 8, "remount read missing");
  f.resolve("A", 6, snapshot(1999, "failed"));
  f.emitRemoved("A", snapshot(2000, "failed"));
  await tick();
  check(state().status === "loading", "unmounted work contaminated the remount");
  f.resolve("A", 7, snapshot(1));
  await ready(1, "remount did not accept a fresh source");
  f.unmount();
  check(
    f.stats("A").listeners === 0 && f.stats("B").listeners === 0,
    "final listener cleanup failed",
  );

  f.mount("read-error");
  await waitFor(() => f.stats("read-error").reads === 1, "error read missing");
  f.reject("read-error", 0);
  await waitFor(() => state().status === "error", "read rejection was not an access error");
  check(state().snapshot === null, "access failure fabricated a backup snapshot");
  f.setSubscribeError("subscribe-error");
  f.mount("subscribe-error");
  await waitFor(() => state().status === "error", "subscribe failure was not an access error");
  check(f.stats("subscribe-error").reads === 0, "read proceeded after failed subscription");
  f.mount("unavailable");
  await waitFor(
    () => state().status === "unavailable",
    "missing platform capability was not unavailable",
  );
  check(
    state().snapshot === null && !state().isRefreshing,
    "unavailable fabricated disabled state",
  );
  f.unmount();
  return "PASS race, refresh, A-B-A, unmount, error/unavailable";
}

export async function presentationAssertions(locale, theme) {
  const f = window.productToolsFixture;
  const check = (value, label) => {
    if (!value) throw new Error(label);
  };
  const tick = () =>
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; ++i) {
      if (predicate()) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(label);
  };
  const zh = locale === "zh-CN";
  const labels = zh
    ? {
        disabled: "未启用",
        waiting: "等待触发",
        running: "正在备份",
        completed: "备份已完成",
        busy: "繁忙，已跳过",
        failed: "备份失败",
      }
    : {
        disabled: "Disabled",
        waiting: "Waiting",
        running: "Running",
        completed: "Completed",
        busy: "Busy — skipped",
        failed: "Failed",
      };
  const section = () => document.getElementById("offline-section");
  const fields = () => [...section().querySelectorAll("dd")];
  const noOverflow = () => {
    check(
      document.documentElement.scrollWidth <= window.innerWidth + 1,
      "document horizontal overflow",
    );
    for (const element of document.querySelectorAll(
      "#offline-section dd, #offline-section p, #offline-section button",
    )) {
      const box = element.getBoundingClientRect();
      check(
        box.left >= -1 && box.right <= window.innerWidth + 1,
        `field escaped viewport: ${element.textContent}`,
      );
      check(
        element.scrollWidth <= element.clientWidth + 1,
        `field content overflows: ${element.textContent}`,
      );
    }
  };
  f.reset(locale, theme);
  f.mount("UI", "section");
  await waitFor(() => f.stats("UI").reads === 1, "section did not read platform state");
  const longRoot = "Z:/isolated/" + "long-unbroken-目录-path".repeat(32);
  const data = {
    revision: 1,
    phase: "disabled",
    offline: false,
    activeProfile: "profile-隔离-with-a-long-name".repeat(6),
    runtimeRoot: longRoot + "/runtime",
    persistentRoot: longRoot + "/persistent",
    periodMs: 60000,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextScheduledAt: null,
    code: null,
  };
  f.resolve("UI", 0, data);
  await waitFor(() => fields().length === 11, "section did not render the complete snapshot");
  for (const [index, phase] of Object.keys(labels).entries()) {
    f.emit("UI", {
      ...data,
      revision: index + 2,
      phase,
      offline: phase !== "disabled",
      code: phase === "failed" ? "isolated-backup-failure" : null,
    });
    await tick();
    const values = fields();
    check(
      values[5].firstElementChild.textContent === labels[phase],
      `incorrect ${phase} phase label`,
    );
    check(
      values[0].textContent ===
        (phase === "disabled"
          ? zh
            ? "未启用共享内存离线运行"
            : "Shared-memory offline runtime not enabled"
          : zh
            ? "已启用 Linux 共享内存运行与持久化备份"
            : "Linux shared-memory runtime and persistent backups enabled"),
      "offline runtime fact not projected",
    );
    check(values[1].textContent === data.activeProfile, "active runtime profile lost");
    check(
      values[2].textContent === data.runtimeRoot && values[3].textContent === data.persistentRoot,
      "local roots lost or truncated",
    );
    check(values[4].textContent === (index + 2).toLocaleString(locale), "revision not projected");
    check(values[6].textContent.includes((60000).toLocaleString(locale)), "backup period lost");
    check(
      values[7].textContent === (zh ? "本次运行无记录" : "No record in this run"),
      "unknown attempt fabricated a date",
    );
    check(values[8].textContent === values[7].textContent, "unknown success fabricated a date");
    check(
      values[9].textContent.includes(zh ? "当前未计划触发点" : "No trigger currently scheduled"),
      "unknown schedule not distinguished",
    );
    check(!section().querySelector("time"), "unknown timestamp rendered as an epoch/date");
    check(
      values[10].textContent ===
        (phase === "failed" ? "isolated-backup-failure" : zh ? "无状态代码" : "No status code"),
      "status code projection incorrect",
    );
    check(
      !section().querySelector('[role="alert"]'),
      "backup failed phase presented as a platform read failure",
    );
    noOverflow();
  }
  const dates = [
    "2026-10-16T10:11:12.000Z",
    "2026-10-16T09:08:07.000Z",
    "2026-10-17T10:11:12.000Z",
  ];
  f.emit("UI", {
    ...data,
    revision: 20,
    phase: "waiting",
    lastAttemptAt: dates[0],
    lastSuccessfulAt: dates[1],
    nextScheduledAt: dates[2],
  });
  await tick();
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const times = [...section().querySelectorAll("time")];
  check(
    times.length === 3 &&
      times.every(
        (time, index) =>
          time.dateTime === dates[index] &&
          time.textContent === formatter.format(new Date(dates[index])),
      ),
    "known timestamps not localized or not preserved",
  );
  check(
    section().textContent.includes(zh ? "共享内存" : "shared memory"),
    "runtime persistence risk omitted",
  );
  check(
    section().querySelectorAll("button").length === 1 && !section().querySelector("input,textarea"),
    "read-only section exposes mutation controls",
  );
  const refresh = section().querySelector("button");
  refresh.click();
  await waitFor(() => f.stats("UI").reads === 2, "actual refresh button did not re-read");
  check(refresh.disabled, "pending read did not disable refresh");
  f.reject("UI", 1);
  await waitFor(
    () => Boolean(section().querySelector('[role="alert"]')),
    "read failure alert missing",
  );
  check(
    section().textContent.includes(zh ? "不表示备份执行失败" : "does not mean a backup failed"),
    "read error conflated with backup failure",
  );
  refresh.click();
  await waitFor(() => f.stats("UI").reads === 3, "error refresh could not retry");
  f.resolve("UI", 2, { ...data, revision: 21, phase: "completed" });
  await waitFor(() => fields().length === 11, "refresh did not recover the real section");
  noOverflow();
  f.mount("unavailable", "section");
  await waitFor(
    () => section().textContent.includes(zh ? "当前平台未提供" : "unavailable on this platform"),
    "unavailable UI missing",
  );
  check(
    !section().querySelector('[role="alert"]') &&
      fields().length === 0 &&
      section().querySelector("button").disabled,
    "unavailable UI masquerades as error or disabled snapshot",
  );
  f.mount("UI", "section");
  await waitFor(() => f.stats("UI").reads === 4, "final screenshot read missing");
  f.resolve("UI", 3, { ...data, revision: 22, phase: "busy" });
  await waitFor(() => fields().length === 11, "final screenshot state missing");
  noOverflow();
  return `PASS ${locale} ${theme}: six phases, timestamps, access states, layout`;
}
