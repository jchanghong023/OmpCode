/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";
import { buildOAuthState, parseOAuthState } from "../src/auth/oauthStateCodec.js";
import { WebAuthService } from "../src/auth/webAuthService.js";
import type { WebZaiOAuthConfig } from "../src/auth/webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "../src/auth/zaiWebOAuthProvider.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const userInfo = { id: "oauth-user", username: "tester", displayName: "OAuth Tester" };
const nonce = "pending-nonce";
type ExchangeParams = Parameters<ZaiWebOAuthProvider["exchangeToken"]>[0];

// 授权 URL 与回调参数仍走真实实现，只有换 token 的网络边界替换为内存结果。
class RecordingOAuthProvider extends ZaiWebOAuthProvider {
  readonly exchanges: ExchangeParams[] = [];

  override async exchangeToken(params: ExchangeParams) {
    this.exchanges.push(params);
    return {
      tokenSet: { accessToken: "access-token", zcodeJwtToken: "jwt-token" },
      userInfo,
      rawUserInfo: userInfo,
    };
  }
}

function createHarness(options: { origin?: string; allowDevReturnToRedirect?: boolean } = {}) {
  const origin = options.origin ?? "https://web.example";
  const config: WebZaiOAuthConfig = {
    authorizeUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    clientId: "public-client",
    redirectUri: "https://web.example/cn/share/callback",
    bigmodelAuthorizeUrl: "https://bigmodel.example/login",
    bigmodelAppId: "public-app",
    allowDevReturnToRedirect: options.allowDevReturnToRedirect ?? false,
  };
  const localStorage = new MemoryStorage();
  const repo = new BrowserOAuthCredentialRepo({
    localStorage,
    sessionStorage: new MemoryStorage(),
  });
  const provider = new RecordingOAuthProvider(config);
  const assigned: string[] = [];
  const replaced: string[] = [];
  const service = new WebAuthService({
    config,
    provider,
    repo,
    runtime: {
      assign: (url) => assigned.push(url),
      replace: (url) => replaced.push(url),
      createNonce: () => nonce,
      getCurrentOrigin: () => origin,
    },
  });
  return { service, repo, provider, assigned, replaced, localStorage, config };
}

function callbackUrl(state: string, path = "/cn/share/callback", origin = "https://web.example") {
  const url = new URL(path, origin);
  url.searchParams.set("code", "authorization-code");
  url.searchParams.set("state", state);
  return url.toString();
}

for (const providerId of [ZAI_PROVIDER_ID, BIGMODEL_PROVIDER_ID] as const) {
  for (const path of ["/cn/share/callback", "/share/callback"]) {
    test(`normal ${providerId} login retains nonce/provider at ${path}`, async () => {
      const harness = createHarness();
      harness.service.startLogin({ provider: providerId });
      const authorization = new URL(harness.assigned[0]!);
      const state = authorization.searchParams.get("state")!;
      assert.deepEqual(parseOAuthState(state), { nonce });
      assert.equal(harness.repo.loadPendingNonce(), nonce);
      assert.equal(harness.repo.loadPendingProvider(), providerId);
      const redirectParam = providerId === BIGMODEL_PROVIDER_ID ? "redirect" : "redirect_uri";
      assert.equal(authorization.searchParams.get(redirectParam), harness.config.redirectUri);

      const result = await harness.service.handleCallback(callbackUrl(state, path));
      assert.deepEqual(result, { userInfo });
      assert.deepEqual(harness.provider.exchanges, [
        {
          code: "authorization-code",
          state,
          provider: providerId,
          redirectUri: harness.config.redirectUri,
        },
      ]);
      assert.equal(harness.repo.loadPendingNonce(), null);
      assert.equal(harness.repo.loadPendingProvider(), null);
      assert.equal(harness.repo.getActiveProvider(), providerId);
      assert.equal(
        harness.localStorage.getItem(`oauth:${providerId}:access_token`),
        "access-token",
      );
      assert.equal(harness.localStorage.getItem("zcodejwttoken"), "jwt-token");
      assert.deepEqual(harness.replaced, []);
    });
  }
}

for (const target of [
  "https://web.example/share/legacy",
  "https://attacker.example/share/legacy",
]) {
  test(`legacy state navigation fields are ignored: ${target}`, async () => {
    const harness = createHarness();
    harness.service.startLogin();
    // 手工编码旧版字段，避免让生产 codec 重新接受已删除的导航参数。
    const state = Buffer.from(
      JSON.stringify({
        nonce,
        app_return_to: target,
        appReturnTo: target,
      }),
    ).toString("base64url");
    assert.deepEqual(parseOAuthState(state), { nonce });
    assert.deepEqual(await harness.service.handleCallback(callbackUrl(state)), { userInfo });
    assert.deepEqual(harness.replaced, []);
    assert.equal(harness.provider.exchanges.length, 1);
  });
}

for (const pendingNonce of [null, "another-login-nonce"]) {
  test(`missing or mismatched nonce rejects before token exchange: ${pendingNonce}`, async () => {
    const harness = createHarness();
    harness.service.startLogin();
    if (pendingNonce === null) harness.repo.clearPendingNonce();
    else harness.repo.savePendingNonce(pendingNonce);
    await assert.rejects(
      harness.service.handleCallback(callbackUrl(buildOAuthState({ nonce }))),
      /OAuth CSRF/,
    );
    assert.deepEqual(harness.provider.exchanges, []);
    assert.deepEqual(harness.replaced, []);
    assert.equal(harness.repo.getActiveProvider(), null);
    assert.equal(harness.repo.loadPendingProvider(), ZAI_PROVIDER_ID);
  });
}

test("consumed nonce cannot replay a successful callback", async () => {
  const harness = createHarness();
  harness.service.startLogin();
  const url = callbackUrl(buildOAuthState({ nonce }));
  await harness.service.handleCallback(url);
  await assert.rejects(harness.service.handleCallback(url), /OAuth CSRF/);
  assert.equal(harness.provider.exchanges.length, 1);
});

for (const path of ["/cn/share/callback", "/share/callback"]) {
  test(`trusted development callback forwards then validates locally: ${path}`, async () => {
    const devOrigin = "http://127.0.0.1:5173";
    const dev = createHarness({ origin: devOrigin });
    dev.service.startLogin({ devReturnTo: `${devOrigin}${path}?discard=old` });
    const state = new URL(dev.assigned[0]!).searchParams.get("state")!;
    const production = createHarness({ allowDevReturnToRedirect: true });
    assert.equal(await production.service.handleCallback(callbackUrl(state)), null);
    const forwarded = new URL(production.replaced[0]!);
    assert.equal(forwarded.origin, devOrigin);
    assert.equal(forwarded.pathname, path);
    assert.equal(forwarded.searchParams.get("state"), state);
    assert.equal(forwarded.searchParams.get("code"), "authorization-code");
    assert.equal(forwarded.searchParams.has("discard"), false);
    assert.deepEqual(production.provider.exchanges, []);
    assert.deepEqual(await dev.service.handleCallback(forwarded.toString()), { userInfo });
    assert.equal(dev.provider.exchanges.length, 1);
    assert.deepEqual(dev.replaced, []);
  });
}

for (const returnTo of [
  "https://attacker.example/share/callback",
  "http://127.0.0.1:5173/share/legacy",
]) {
  test(`untrusted development return_to cannot bypass local nonce checks: ${returnTo}`, async () => {
    const harness = createHarness({ allowDevReturnToRedirect: true });
    const state = buildOAuthState({ nonce, return_to: returnTo });
    await assert.rejects(harness.service.handleCallback(callbackUrl(state)), /OAuth CSRF/);
    assert.deepEqual(harness.replaced, []);
    assert.deepEqual(harness.provider.exchanges, []);
  });
}

test("development forwarding remains opt-in", async () => {
  const harness = createHarness();
  const state = buildOAuthState({ nonce, return_to: "http://localhost:5173/share/callback" });
  await assert.rejects(harness.service.handleCallback(callbackUrl(state)), /OAuth CSRF/);
  assert.deepEqual(harness.replaced, []);
  assert.deepEqual(harness.provider.exchanges, []);
});
