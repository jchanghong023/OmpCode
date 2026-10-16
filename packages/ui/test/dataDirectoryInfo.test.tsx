import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DataDirectoryInfo } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { DataBaseDirControl } from "../src/settings/DataBaseDirControl.js";

for (const locale of ["en-US", "zh-CN"] as const) {
  test(`offline directory display exposes both roots without editing controls (${locale})`, () => {
    const directoryInfo: DataDirectoryInfo = {
      runtimeRoot: "/dev/shm/ompcode-1000-example/omp_ompcode",
      persistentRoot: "/nfs/example/omp_ompcode",
      offline: true,
    };
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: locale,
        children: createElement(DataBaseDirControl, { directoryInfo }),
      }),
    );
    assert.ok(html.includes(directoryInfo.runtimeRoot));
    assert.ok(html.includes(directoryInfo.persistentRoot));
    assert.equal((html.match(/<input\b/gu) ?? []).length, 2);
    assert.equal((html.match(/readOnly=""/gu) ?? []).length, 2);
    assert.doesNotMatch(html, /<button\b/u);
  });
}

test("nonoffline Windows directory display preserves its single read-only path", () => {
  const directoryInfo: DataDirectoryInfo = {
    runtimeRoot: "D:\\isolated\\omp_ompcode",
    persistentRoot: "D:\\isolated\\omp_ompcode",
    offline: false,
  };
  const html = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(DataBaseDirControl, { directoryInfo, isWindowsDesktop: true }),
    }),
  );
  assert.ok(html.includes(directoryInfo.runtimeRoot));
  assert.equal((html.match(/<input\b/gu) ?? []).length, 1);
  assert.match(html, /readOnly=""/u);
  assert.doesNotMatch(html, /<button\b/u);
});
