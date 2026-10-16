import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureOfflineDataRoot,
  isOfflineShmEnabled,
  resolveOfflineDataRoots,
  resolveOmpAgentDir,
  resolveOmpCodeDataRootFromEnv,
  resolveOmpCodePersistentRoot,
  resolveOmpConfigRoot,
  resolveOmpRuntimeRoot,
} from "../src/node.js";

const machine = { platform: "linux" as const, hostname: "host-a", uid: 1001 };
const home = "/nfs/user";
const persistentRoot = "/nfs/user/omp-data";
const expected =
  "/dev/shm/omp-1001-5b54d7dada7321625ea1f232ab0f3f3bfd6812abd77a57a7dab55278a0c4eadd/omp-data";

test("offline 真值仅在 Linux 启用，原始根和 OMP_CONFIG_ROOT 保持不变", () => {
  // OMP offline-root.js 的 normalize 保留尾分隔符；活动域散列须与核心逐字一致。
  const runtimeWithTrailing =
    "/dev/shm/omp-1001-72465a311cf96429a80b4a51ae32ab78baccace1089415dfec6163bf2f2bfb00/omp-data";
  for (const value of ["1", "true", " YES ", "On"]) {
    const env = {
      OMP_OFFLINE: value,
      OMP_CONFIG_ROOT: `${persistentRoot}/`,
      PI_CONFIG_DIR: "ignored",
    };
    assert.equal(isOfflineShmEnabled(env, "linux"), true);
    assert.equal(resolveOmpConfigRoot(home, env, machine), `${persistentRoot}/`);
    assert.equal(resolveOmpRuntimeRoot(home, env, machine), runtimeWithTrailing);
    assert.equal(
      resolveOmpAgentDir(home, { ...env, OMP_PROFILE: "work" }, machine),
      `${runtimeWithTrailing}/profiles/work/agent`,
    );
    assert.equal(env.OMP_CONFIG_ROOT, `${persistentRoot}/`);
    assert.equal(env.PI_CONFIG_DIR, "ignored");
    for (const platform of ["win32", "darwin"] as const) {
      assert.equal(
        resolveOfflineDataRoots(persistentRoot, "omp", { ...machine, platform, env }),
        undefined,
      );
    }
  }
  for (const OMP_OFFLINE of [undefined, "", " ", "0", "false", "yes-please"]) {
    const env = { OMP_OFFLINE, OMP_CONFIG_ROOT: persistentRoot };
    assert.equal(resolveOmpRuntimeRoot(home, env, machine), persistentRoot);
    assert.equal(
      resolveOfflineDataRoots(persistentRoot, "ompcode", { ...machine, env }),
      undefined,
    );
  }
});

test("活动域隔离用户、主机、原始根和应用，profile 不改变数据域", () => {
  const env = { OMP_OFFLINE: "true" };
  const options = { ...machine, env };
  const reference = resolveOfflineDataRoots(persistentRoot, "omp", options)!;
  assert.equal(reference.runtimeRoot, expected);
  for (const changed of [
    resolveOfflineDataRoots(persistentRoot, "omp", { ...options, uid: 1002 }),
    resolveOfflineDataRoots(persistentRoot, "omp", { ...options, hostname: "host-b" }),
    resolveOfflineDataRoots("/another/user/omp-data", "omp", options),
    resolveOfflineDataRoots(persistentRoot, "ompcode", options),
  ]) {
    assert.notEqual(changed!.runtimeRoot, reference.runtimeRoot);
  }
  assert.deepEqual(
    resolveOfflineDataRoots(persistentRoot, "omp", {
      ...options,
      env: { ...env, OMP_PROFILE: "work" },
    }),
    reference,
  );
});

test("空值和无效根按 OMP 默认解析，应用默认根也映射到 shm", () => {
  for (const OMP_CONFIG_ROOT of [undefined, "", " ", "relative", "../relative"]) {
    const env = { OMP_OFFLINE: "1", OMP_CONFIG_ROOT };
    assert.equal(resolveOmpConfigRoot(home, env, machine), `${home}/.omp`);
    assert.equal(resolveOmpCodePersistentRoot(home, env, machine), `${home}/.ompcode`);
    const app = resolveOmpCodeDataRootFromEnv(home, env, machine)!;
    assert.match(app, /^\/dev\/shm\/ompcode-1001-[a-f0-9]{64}\/\.ompcode$/);
    assert.notEqual(app, resolveOmpRuntimeRoot(home, env, machine));
  }
  const env = { OMP_OFFLINE: "on", OMP_CONFIG_ROOT: "~/omp-data", PI_CONFIG_DIR: "other" };
  assert.equal(resolveOmpRuntimeRoot(home, env, machine), expected);
  assert.equal(resolveOmpCodePersistentRoot(home, env, machine), `${persistentRoot}_ompcode`);
  assert.match(resolveOmpCodeDataRootFromEnv(home, env, machine)!, /\/omp-data_ompcode$/);
  assert.equal(
    resolveOmpConfigRoot(home, { OMP_OFFLINE: "1", PI_CONFIG_DIR: "legacy" }, machine),
    `${home}/legacy`,
  );
});

test("非 offline 路径不变，非法运行根在任何文件 IO 前拒绝", () => {
  assert.equal(resolveOmpCodeDataRootFromEnv(home, {}, machine), undefined);
  assert.equal(
    resolveOmpCodeDataRootFromEnv(home, { OMP_CONFIG_ROOT: persistentRoot }, machine),
    `${persistentRoot}_ompcode`,
  );
  for (const runtimeRoot of ["/dev/shm", "/dev/shm/../outside", "/nfs/user"]) {
    assert.throws(
      () => ensureOfflineDataRoot({ persistentRoot, runtimeRoot, domainId: "invalid" }),
      /inside \/dev\/shm/,
    );
  }
});
