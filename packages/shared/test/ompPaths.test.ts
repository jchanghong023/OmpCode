import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";
import {
  resolveOmpAgentDir,
  resolveOmpConfigRoot,
  resolveOmpCodeDataRootFromEnv,
} from "../src/node.js";

test("OMP_CONFIG_ROOT 优先于 PI_CONFIG_DIR，展开 ~，忽略空值和相对值", () => {
  const home = join(tmpdir(), "omp-home");
  const root = join(tmpdir(), "omp-root");
  assert.equal(resolveOmpConfigRoot(home, {}), join(home, ".omp"));
  assert.equal(
    resolveOmpConfigRoot(home, { OMP_CONFIG_ROOT: ` ${root} `, PI_CONFIG_DIR: "legacy" }),
    root,
  );
  assert.equal(resolveOmpConfigRoot(home, { OMP_CONFIG_ROOT: "~" }), home);
  for (const value of ["~/data", "~\\data"]) {
    assert.equal(
      resolveOmpConfigRoot(home, { OMP_CONFIG_ROOT: value }),
      normalize(home + value.slice(1)),
    );
  }
  for (const value of [undefined, "", " ", "relative-root", "../data", "~other/data"]) {
    assert.equal(resolveOmpConfigRoot(home, { OMP_CONFIG_ROOT: value }), join(home, ".omp"));
    assert.equal(
      resolveOmpConfigRoot(home, { OMP_CONFIG_ROOT: value, PI_CONFIG_DIR: "../legacy" }),
      resolve(home, "../legacy"),
    );
  }
});

test("OMP_CONFIG_ROOT 下默认和命名 profile 派生同一 agent 根", () => {
  const home = join(tmpdir(), "omp-home");
  const env = { OMP_CONFIG_ROOT: "~/data", PI_CONFIG_DIR: "ignored" };
  assert.equal(resolveOmpAgentDir(home, env), join(home, "data", "agent"));
  assert.equal(
    resolveOmpAgentDir(home, { ...env, OMP_PROFILE: "work" }),
    join(home, "data", "profiles", "work", "agent"),
  );
  assert.equal(
    resolveOmpAgentDir(home, { ...env, OMP_PROFILE: "", PI_PROFILE: "legacy" }),
    join(home, "data", "agent"),
  );
});

test("OmpCode 由有效 OMP_CONFIG_ROOT 派生独立兄弟根，未设置时不覆盖默认目录", () => {
  const home = join(tmpdir(), "omp-home");
  const root = join(tmpdir(), "omp-data");
  for (const OMP_CONFIG_ROOT of [root, `${root}/`, ` ${root} `]) {
    assert.equal(resolveOmpCodeDataRootFromEnv(home, { OMP_CONFIG_ROOT }), `${root}_ompcode`);
  }
  assert.equal(
    resolveOmpCodeDataRootFromEnv(home, { OMP_CONFIG_ROOT: "~/data" }),
    join(home, "data_ompcode"),
  );
  assert.equal(resolveOmpCodeDataRootFromEnv(home, { OMP_CONFIG_ROOT: "~" }), `${home}_ompcode`);
  for (const OMP_CONFIG_ROOT of [undefined, "", " ", "relative", "../data"]) {
    assert.equal(
      resolveOmpCodeDataRootFromEnv(home, { OMP_CONFIG_ROOT, PI_CONFIG_DIR: root }),
      undefined,
    );
  }
});
