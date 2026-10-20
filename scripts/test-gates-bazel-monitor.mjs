import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatesInputsDir } from "./test-gates-bazel-locations.mjs";
import { parseBuildEventFile } from "./test-gates-bep.mjs";

// 实际执行仍使用同一首失败通道；只读缓存检查不产生工具或测试执行帧。
export function monitorBazelStage(targets, bepPath, clock, onFailure) {
  const activeKinds = new Map();
  const seen = new Map();
  let failure;
  const notify = (reason, target) => {
    if (!failure) {
      failure = reason;
      onFailure?.({ status: "FAIL", exitCode: 1, reason, ...(target ? { target } : {}) });
    }
  };
  const observe = async () => {
    for (const target of targets) {
      const text = await readFile(join(gatesInputsDir, `${target}.live`), "utf8").catch(() => "");
      const lines = text.split("\n");
      for (const line of lines.slice(seen.get(target) ?? 0, -1)) {
        if (line.startsWith("\u001eOMP_TEST_FAILURE ")) {
          try {
            const frame = JSON.parse(line.slice("\u001eOMP_TEST_FAILURE ".length));
            notify(`${frame.name}: ${frame.error}`, target);
          } catch {}
        }
        if (line.startsWith("\u001eOMP_GATE_KIND ")) {
          try {
            const frame = JSON.parse(line.slice("\u001eOMP_GATE_KIND ".length));
            if (frame.event === "start" && !activeKinds.has(target))
              activeKinds.set(target, clock?.enter(frame.kind));
            if (frame.event === "end") {
              activeKinds.get(target)?.();
              activeKinds.delete(target);
            }
          } catch {}
        }
      }
      seen.set(target, lines.length - 1);
    }
    for (const [target, event] of await parseBuildEventFile(bepPath, targets))
      if (
        ["FAILED", "TIMEOUT", "INCOMPLETE", "REMOTE_FAILURE", "FAILED_TO_BUILD"].includes(
          event.status,
        )
      )
        notify(`bazel target ${target} ${event.status}`, target);
  };
  let observing = Promise.resolve();
  const watcher = setInterval(() => {
    observing = observing.then(observe).catch((error) => notify(String(error)));
  }, 100);
  return {
    failure: () => failure,
    async stop() {
      clearInterval(watcher);
      try {
        await observing;
        await observe();
      } finally {
        for (const end of activeKinds.values()) end?.();
      }
    },
  };
}
