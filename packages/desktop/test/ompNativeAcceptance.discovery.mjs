import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./ompNativeAcceptance.helpers.mjs";

export async function repositoryDiscoveryComplete(runtime, isolationTask) {
  assert.match(isolationTask, /^task-item-[0-9a-f-]{36}$/iu);
  const isolationSession = isolationTask.slice("task-item-".length);
  const root = join(runtime.configRoot, "logs");
  await eventually(
    async () => {
      const owners = [];
      let isolationReceipt = false;
      for (const name of (await readdir(root)).filter((name) => name.endsWith(".log"))) {
        const text = await readFile(join(root, name), "utf8");
        const events = text
          .slice(0, text.lastIndexOf("\n") + 1)
          .split("\n")
          .filter(
            (line) =>
              line.includes('"event":"repo_discovery_hint"') ||
              line.includes('"event":"startup_model_selected"'),
          )
          .map((line) => JSON.parse(line));
        const startup = events.find(
          (event) =>
            event.event === "startup_model_selected" && event.session_id === isolationSession,
        );
        const pid = events.find((event) => event.pid)?.pid;
        if (!pid) continue;
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          alive = false;
        }
        // 已退出旧进程不能再提交索引；但目标隔离会话仍须提供匹配的完成收据。
        if (!alive && !startup) continue;
        const pending = new Map();
        const sessions = new Map();
        let queued = false;
        for (const event of events) {
          if (event.event === "startup_model_selected") {
            sessions.set(event.operation_id, event.session_id);
            continue;
          }
          assert.ok(
            event.pid && event.operation_id && event.source,
            "Discovery receipts must identify their actual process, operation and source",
          );
          const key = JSON.stringify([event.pid, event.operation_id, event.source]);
          if (event.stage === "queue" && event.result === "coalesced") queued = true;
          if (event.stage !== "discover") continue;
          if (event.result === "started") {
            assert.equal(pending.has(key), false, `Duplicate discovery admission ${key}`);
            pending.set(key, event);
            queued = false;
          } else if (event.message === "Repository lifecycle discovery ended") {
            assert.equal(
              event.result,
              "completed",
              `Repository discovery owner ${event.pid}/${event.operation_id} must complete`,
            );
            assert.ok(pending.has(key), `Discovery completion has no matching admission ${key}`);
            pending.delete(key);
            if (
              startup &&
              event.pid === startup.pid &&
              event.operation_id === startup.operation_id &&
              event.source === "session"
            )
              isolationReceipt = true;
          }
        }
        if (pending.size !== 0 || queued)
          owners.push({
            log: name,
            pending: [...pending.values()].map((event) => ({
              pid: event.pid,
              operation: event.operation_id,
              source: event.source,
              session: event.session_id ?? sessions.get(event.operation_id),
            })),
            queued,
          });
      }
      return { owners, isolationReceipt };
    },
    ({ owners, isolationReceipt }) => isolationReceipt && owners.length === 0,
    "Actual repository lifecycle discovery completion before cancellation baseline",
  );
}
