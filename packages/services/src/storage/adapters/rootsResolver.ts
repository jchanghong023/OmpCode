/**
 * 调用方注入实际应用根时只扫描该根；旧调用方保留 home/base 的 .ompcode 布局。
 * Desktop Main 传入共享路径解析结果，模块内不再读取环境变量或自行决定新根。
 */
import { join, resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";

const ZCODE_DATA_DIR_NAME = ".ompcode";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
  dataRootDir?: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  if (params.dataRootDir) {
    const dataRoot = resolve(params.dataRootDir);
    const hasCustomDataBaseDir = dataRoot !== join(home, ZCODE_DATA_DIR_NAME);
    return [
      { id: hasCustomDataBaseDir ? "dataBaseDir" : "home", path: dataRoot, hasCustomDataBaseDir },
    ];
  }
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: join(home, ZCODE_DATA_DIR_NAME), hasCustomDataBaseDir },
  ];
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: join(dataBase, ZCODE_DATA_DIR_NAME),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
  getDataRootDir?: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({
        homeDir: params.getHomeDir(),
        dataBaseDir: params.getDataBaseDir(),
        dataRootDir: params.getDataRootDir?.(),
      }),
  };
}
