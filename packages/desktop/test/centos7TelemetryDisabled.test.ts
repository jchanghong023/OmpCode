import assert from "node:assert/strict";
import test from "node:test";
import { createAppTelemetryRuntime } from "../src/main/appTelemetryRuntime.js";

test("CentOS 7 desktop does not schedule or submit app telemetry", () => {
  let scheduled = 0;
  let reports = 0;
  const runtime = createAppTelemetryRuntime({
    enabled: false,
    telemetryCore: {
      reportAppLaunch: async () => {
        reports += 1;
      },
      reportAppDailyActive: async () => {
        reports += 1;
      },
    },
    appLaunchCoordinator: {
      onRendererReady: () => true,
      onOAuthCallbackHandled: () => true,
    },
    setInterval: () => {
      scheduled += 1;
      return 1;
    },
    clearInterval: () => {},
  });
  runtime.setInteractive(true);
  runtime.onRendererReady({ hasPendingOAuthCallback: false, rendererId: 1 });
  runtime.onOAuthCallbackHandled({ rendererId: 1 });
  runtime.dispose();
  assert.equal(scheduled, 0);
  assert.equal(reports, 0);
});
