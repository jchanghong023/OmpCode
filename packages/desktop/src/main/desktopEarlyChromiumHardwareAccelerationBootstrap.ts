import "./desktopEarlyOfflineDataBootstrap.js";
import { app } from "electron";
import { applyEarlyChromiumHardwareAccelerationBootstrap } from "./desktopChromiumHardwareAccelerationBootstrap.js";

applyEarlyChromiumHardwareAccelerationBootstrap(app);
