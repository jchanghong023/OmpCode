import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import forge from "node-forge";
import { loadOrCreateMobileRelayCertificate } from "../src/main/mobileRelay/mobileRelayCertificate.js";
import { buildMobileRelayEntryUrl, MOBILE_RELAY_PUBLIC_ORIGIN } from "../src/main/mobileRelay/mobileRelayProtocol.js";

test("入口链接：固定公网 origin + /remote/v4 + sid/hash/t 参数形状", () => {
  const url = new URL(buildMobileRelayEntryUrl());
  assert.equal(url.origin, MOBILE_RELAY_PUBLIC_ORIGIN);
  assert.equal(url.pathname, "/remote/v4");
  assert.ok(url.searchParams.get("sid"));
  assert.ok(url.searchParams.get("hash"));
  const timestamp = Number(url.searchParams.get("t"));
  assert.ok(Number.isFinite(timestamp) && timestamp > 0);
  // 每次生成的 sid/hash 随机，不重复。
  assert.notEqual(buildMobileRelayEntryUrl(), buildMobileRelayEntryUrl());
});

test("证书：首次生成自签 CA + leaf，SAN 覆盖公网 IP/回环/localhost，且幂等复用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobile-relay-cert-"));
  try {
    const first = await loadOrCreateMobileRelayCertificate(dir);
    assert.ok(first.caPem.includes("BEGIN CERTIFICATE"));
    assert.ok(first.certPem.includes("BEGIN CERTIFICATE"));
    assert.ok(first.keyPem.includes("PRIVATE KEY"));

    const ca = forge.pki.certificateFromPem(first.caPem);
    assert.equal(
      ca.getExtension("basicConstraints")?.cA,
      true,
      "CA 证书必须 CA:TRUE，手机端作为用户 CA 安装",
    );

    const leaf = forge.pki.certificateFromPem(first.certPem);
    const san = leaf.getExtension("subjectAltName")?.altNames as Array<{
      type: number;
      value?: string;
      ip?: string;
    }>;
    const publicHost = new URL(MOBILE_RELAY_PUBLIC_ORIGIN).hostname;
    assert.ok(
      san.some((item) => item.type === 7 && item.ip === publicHost),
      `SAN 必须覆盖公网 IP ${publicHost}`,
    );
    assert.ok(san.some((item) => item.type === 7 && item.ip === "127.0.0.1"));
    assert.ok(san.some((item) => item.type === 2 && item.value === "localhost"));

    // CA 能验证 leaf 签名（手机端链验证的等价检查）。
    assert.ok(ca.verify(leaf));

    // 幂等：再次加载返回同一份证书。
    const second = await loadOrCreateMobileRelayCertificate(dir);
    assert.equal(second.certPem, first.certPem);
    assert.equal(second.keyPem, first.keyPem);

    // 导出副本内容与 CA 一致，供手机安装。
    const exported = await readFile(join(dir, "mobile-relay", "ca-export.pem"), "utf8");
    assert.equal(exported, first.caPem);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
