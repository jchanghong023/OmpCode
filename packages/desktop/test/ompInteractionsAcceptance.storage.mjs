import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROBES, probeSpec } from "./ompInteractionsAcceptance.contract.mjs";

async function storageFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    assert.equal(
      entry.isSymbolicLink(),
      false,
      "Never scan storage outside this owned runtime root",
    );
    if (entry.isDirectory()) {
      if (!/^(?:Cache|Code Cache|GPUCache|DawnCache|Crashpad)$/u.test(entry.name))
        files.push(...(await storageFiles(path)));
    } else if (
      entry.isFile() &&
      // LevelDB 的 LOCK 只承载进程互斥，不保存草稿字节；Windows 活动锁不可读。
      entry.name !== "LOCK" &&
      /(?:Local Storage|Session Storage|IndexedDB|WebStorage|draft)/iu.test(path)
    ) {
      files.push(path);
    }
  }
  return files;
}

async function remoteValue(cdp, remote) {
  if (!remote.objectId) return remote.value ?? remote.unserializableValue ?? remote.description;
  const value = await cdp.send("Runtime.callFunctionOn", {
    objectId: remote.objectId,
    functionDeclaration: "function () { return JSON.stringify(this); }",
    returnByValue: true,
  });
  assert.equal(value.exceptionDetails, undefined, "Every real IndexedDB draft must be readable");
  assert.equal(typeof value.result.value, "string");
  await cdp.send("Runtime.releaseObject", { objectId: remote.objectId });
  return value.result.value;
}

async function logicalStorage(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const securityOrigin = new URL(page.url()).origin;
    await cdp.send("DOMStorage.enable");
    await cdp.send("IndexedDB.enable");
    const logical = [];
    for (const isLocalStorage of [true, false]) {
      const { entries } = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin, isLocalStorage },
      });
      for (const [key, value] of entries)
        logical.push({ source: isLocalStorage ? "localStorage" : "sessionStorage", key, value });
    }
    const { databaseNames } = await cdp.send("IndexedDB.requestDatabaseNames", { securityOrigin });
    for (const databaseName of databaseNames) {
      const { databaseWithObjectStores } = await cdp.send("IndexedDB.requestDatabase", {
        securityOrigin,
        databaseName,
      });
      for (const store of databaseWithObjectStores.objectStores) {
        let skipCount = 0;
        let hasMore;
        do {
          assert.ok(skipCount < 10_000, "Do not silently truncate an owned persistent-draft scan");
          const result = await cdp.send("IndexedDB.requestData", {
            securityOrigin,
            databaseName,
            objectStoreName: store.name,
            indexName: "",
            skipCount,
            pageSize: 100,
          });
          hasMore = result.hasMore;
          assert.ok(
            !hasMore || result.objectStoreDataEntries.length > 0,
            "IndexedDB pagination must make progress",
          );
          for (const entry of result.objectStoreDataEntries) {
            logical.push({
              source: `${databaseName}/${store.name}`,
              key: await remoteValue(cdp, entry.primaryKey),
              value: await remoteValue(cdp, entry.value),
            });
          }
          skipCount += result.objectStoreDataEntries.length;
        } while (hasMore);
      }
    }
    return logical;
  } finally {
    await cdp.detach();
  }
}

export async function assertSensitiveDraftsAbsent(
  page,
  runtime,
  { requirePublicDraft = false } = {},
) {
  const { nonce, publicDraft } = runtime.acceptance;
  // 探针集已无 sensitive 样本（omp rpc-ui 基线不下发该标记，证据见 contract.mjs）：
  // 扫描集为空时不做计数断言，其余断言仍校验真实存储被观察到及公开草稿正对照。
  const secrets = PROBES.map((name) => probeSpec(name, nonce))
    .filter((spec) => spec.sensitive)
    .flatMap((spec) => [spec.prefill, spec.value]);
  const logical = await logicalStorage(page);
  assert.ok(
    logical.length > 0,
    "The real owned browser storage must be observed, not an empty fake draft collection",
  );
  const serialized = JSON.stringify(logical);
  for (let index = 0; index < secrets.length; index++) {
    assert.equal(
      serialized.includes(secrets[index]),
      false,
      `Sensitive sample ${index} leaked into logical browser storage`,
    );
  }
  if (requirePublicDraft)
    assert.ok(
      serialized.includes(publicDraft),
      "A real ordinary Composer draft is the positive control for this persistence scan",
    );
  // OMP_CONFIG_ROOT 的产品路径优先于测试旧环境覆盖，扫描实际派生的 Chromium 根。
  const browserRoot = join(`${runtime.configRoot}_ompcode`, "electron", "OmpCode Core Acceptance");
  const paths = await storageFiles(browserRoot);
  let bytesScanned = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    bytesScanned += bytes.length;
    for (let index = 0; index < secrets.length; index++) {
      const secret = secrets[index];
      for (const value of [secret, JSON.stringify(secret).slice(1, -1)]) {
        for (const encoding of ["utf8", "utf16le"]) {
          assert.equal(
            bytes.includes(Buffer.from(value, encoding)),
            false,
            `Sensitive sample ${index} leaked into owned persistent draft bytes (${encoding})`,
          );
        }
      }
    }
  }
  const publicDraftPresent = serialized.includes(publicDraft);
  // 文件/字节计数记录当前真实落盘覆盖；逻辑扫描不等于 Chromium 已完成退出落盘。
  return {
    logicalEntries: logical.length,
    files: paths.length,
    bytesScanned,
    publicDraftPresent,
  };
}
