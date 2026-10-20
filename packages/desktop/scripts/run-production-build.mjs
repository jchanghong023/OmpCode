import { rm } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";

function resolveDesktopProductionCleanPaths(cwd) {
  return [
    resolve(cwd, "out/main"),
    resolve(cwd, "out/host"),
    resolve(cwd, "out/preload"),
    resolve(cwd, "out/renderer"),
    resolve(cwd, "out/.main-build-ready"),
    resolve(cwd, "out/.host-build-ready"),
    resolve(cwd, "out/.preload-build-ready"),
  ];
}

export async function cleanDesktopProductionOutput({ cwd }) {
  if (process.env.ZCODE_E2E_KEEP_BUILD_CACHE === "1") {
    console.log("[build] ZCODE_E2E_KEEP_BUILD_CACHE=1, skipping clean");
    return;
  }
  // 生产构建之前如果已有开发态/旧生产态 out，tsup 不会主动删除过期 chunk。
  // 这些旧文件会继续被 electron-builder 的 out/**/* 打进 app.asar，重新暴露未压缩 JS 和 sourcemap 尾注。
  await Promise.all(
    resolveDesktopProductionCleanPaths(cwd).map((targetPath) =>
      rm(targetPath, { force: true, recursive: true }),
    ),
  );
}
