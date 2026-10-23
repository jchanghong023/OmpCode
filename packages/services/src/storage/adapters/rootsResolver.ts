/**
 * 只解析当前应用数据根；路径事实由启动路径所有者注入，不读取 HOME 或环境变量。
 */
import { resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";

export function resolveStorageRoots(params: { dataBaseDir: string }): StorageRootSpec[] {
  // getDataBaseDir 已返回完整 OmpCode 根；再拼 .zcode 或追加 HOME 会扫描并误删上游数据。
  return [{ id: "dataBaseDir", path: resolve(params.dataBaseDir), hasCustomDataBaseDir: false }];
}

export function createStorageRootsResolver(params: {
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () => resolveStorageRoots({ dataBaseDir: params.getDataBaseDir() }),
  };
}
