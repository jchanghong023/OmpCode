import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { DockerBackend } from "../src/remote/docker-backend.js";
import { OwnedChildRegistry } from "../src/remote/ownedChildRegistry.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 常驻型子进程：stdin 保持读取 + 空转定时器，stdin EOF 也不会自行退出，需要 kill 兜底。 */
function spawnHangingChild() {
  return spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1_000);"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

/** stdin 驱动退出型子进程：stdin EOF 后立即退出，用于验证 end stdin 的宽限路径。 */
function spawnStdinExitChild() {
  return spawn(
    process.execPath,
    ["-e", "process.stdin.once('end', () => process.exit(0)); process.stdin.resume();"],
    { stdio: "pipe", windowsHide: true },
  );
}

test("owned child is removed from the registry once a one-shot command exits", async () => {
  const registry = new OwnedChildRegistry();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "pipe", windowsHide: true });
  registry.track(child);
  assert.equal(registry.size, 1);

  await once(child, "close");
  // 一次性命令正常完成后必须立即出队，避免 owned 集合无界增长。
  assert.equal(registry.size, 0);
});

test("disposeAndWait ends stdin first so stdin-driven children exit within grace", async () => {
  const registry = new OwnedChildRegistry();
  const child = spawnStdinExitChild();
  registry.track(child);
  await sleep(100);

  await registry.disposeAndWait({ graceTimeoutMs: 1_000, killWaitTimeoutMs: 500 });

  assert.equal(registry.size, 0);
  // 宽限路径：stdin EOF 足以让子进程正常退出，不应走到 kill。
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("disposeAndWait kills children that ignore stdin EOF after the grace window", async () => {
  const registry = new OwnedChildRegistry();
  const child = spawnHangingChild();
  registry.track(child);
  await sleep(100);
  const startedAt = Date.now();

  await registry.disposeAndWait({ graceTimeoutMs: 80, killWaitTimeoutMs: 5_000 });

  assert.equal(registry.size, 0);
  // kill 兜底：忽略 stdin EOF 的常驻子进程在宽限期后被杀死。
  assert.notEqual(child.signalCode, null);
  assert.ok(Date.now() - startedAt >= 80);
});

test("DockerBackend dispose stays synchronous and memoizes disposeAndWait", async () => {
  const backend = new DockerBackend({ kind: "docker", container: "unused" });

  // IRemoteBackend/IDisposable 契约：dispose() 必须保持同步签名（connect.ts 直接调用）。
  assert.equal(backend.dispose(), undefined);
  const first = backend.disposeAndWait();
  const second = backend.disposeAndWait();
  assert.equal(first, second);
  await first;
});
