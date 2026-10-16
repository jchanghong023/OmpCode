import { app } from "electron";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import {
  ensureOfflineDataRoot,
  resolveOfflineDataRoots,
  resolveOmpConfigRoot,
} from "@zcode/shared/node";
import {
  applyOfflineDesktopElectronPaths,
  initializeOfflineDesktopEnvironment,
  resolveOfflineDesktopPaths,
} from "./offlineDesktopPaths.js";

const applicationName =
  process.env.ZCODE_DESKTOP_APPLICATION_NAME?.trim() ||
  (!app.isPackaged
    ? "OmpCode Dev"
    : ZCODE_PRODUCT_FLAVOR === "preview"
      ? "OmpCode Preview"
      : "OmpCode");

// This module must precede settings, services, logger and crash-capture imports in Main.
export const offlineDesktopPaths = resolveOfflineDesktopPaths(applicationName);
if (offlineDesktopPaths) {
  const ompRoots = resolveOfflineDataRoots(resolveOmpConfigRoot(), "omp");
  if (ompRoots) ensureOfflineDataRoot(ompRoots);
  initializeOfflineDesktopEnvironment(offlineDesktopPaths);
  applyOfflineDesktopElectronPaths(app, offlineDesktopPaths);
}
