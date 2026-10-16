import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Host-derived paths; never persisted as mutable app settings. */
export interface DataDirectoryInfo {
  runtimeRoot: string;
  persistentRoot: string;
  offline: boolean;
}

export interface ISettingService {
  get(): Promise<AppSettings>;
  getDataDirectoryInfo(): Promise<DataDirectoryInfo>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  /** 旧客户端兼容入口：始终拒绝，应用路径只由 OMP_CONFIG_ROOT 决定。 */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
