import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOmpDesktopDataPaths } from "../src/main/OmpDesktopDataPaths.js";

test("有效环境根覆盖旧 Electron 路径，业务与缓存使用同一派生根", () => {
  const home = join(tmpdir(), "omp-desktop-home");
  const ompRoot = join(home, "omp-data");
  const root = `${ompRoot}_ompcode`;
  const userData = join(root, "electron", "OmpCode");
  assert.deepEqual(
    resolveOmpDesktopDataPaths(
      "OmpCode",
      {
        OMP_CONFIG_ROOT: `${ompRoot}/`,
        ZCODE_DESKTOP_USER_DATA_DIR: join(home, "old-user-data"),
        ZCODE_DESKTOP_SESSION_DATA_DIR: join(home, "old-session-data"),
      },
      home,
    ),
    { root, userData, sessionData: join(userData, "session") },
  );
  assert.equal(
    resolveOmpDesktopDataPaths("OmpCode", { OMP_CONFIG_ROOT: "~/data" }, home)?.root,
    join(home, "data_ompcode"),
  );
});

test("无有效 OMP_CONFIG_ROOT 时保留桌面默认路径解析", () => {
  for (const OMP_CONFIG_ROOT of [undefined, "", " ", "relative", "../data"]) {
    assert.equal(resolveOmpDesktopDataPaths("OmpCode", { OMP_CONFIG_ROOT }), undefined);
  }
});
