const budgets = { fastcheck: 60, fulltest: 900, slowtest: 1500 };

export function gateBudget(level, requested = budgets[level]) {
  const maximum = budgets[level];
  if (!maximum || !Number.isFinite(requested) || requested <= 0 || requested > maximum)
    throw new Error(
      `${level} budget must be positive and at most ${maximum} seconds; it may only be lowered`,
    );
  return requested;
}

export function createGateClock(started = performance.now()) {
  let updated = started;
  let excluded = 0;
  let compile = 0;
  let charged = 0;
  const listeners = new Set();
  const update = () => {
    const now = performance.now();
    if (compile > 0 && charged === 0) excluded += now - updated;
    updated = now;
    return now;
  };
  return {
    read() {
      const total = (update() - started) / 1000;
      const compileExcluded = excluded / 1000;
      return { total, compileExcluded, budgeted: total - compileExcluded };
    },
    enter(kind = "check") {
      if (!["compile", "check", "test"].includes(kind))
        throw new Error(`Unknown gate stage kind: ${kind}`);
      update();
      if (kind === "compile") compile++;
      else charged++;
      for (const notify of listeners) notify();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        update();
        if (kind === "compile") compile--;
        else charged--;
        for (const notify of listeners) notify();
      };
    },
    compileOnly: () => compile > 0 && charged === 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
