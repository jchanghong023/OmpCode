import {
  initializeOfflineDesktopEnvironment,
  resolveOfflineDesktopPaths,
} from "./offlineDesktopPaths.js";

// Runs with ELECTRON_RUN_AS_NODE before Chromium/GTK can choose default disk directories.
// NUL framing preserves whitespace/newlines in roots and lets the shell reject bootstrap failure.
const paths = resolveOfflineDesktopPaths("OmpCode");
if (!paths) throw new Error("Offline launcher requires Linux OMP_OFFLINE");
initializeOfflineDesktopEnvironment(paths);
process.stdout.write(`${paths.roots.runtimeRoot}\0`);
