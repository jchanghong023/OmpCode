const WEB_CALLBACK_PATHS = new Set(["/cn/share/callback", "/share/callback"]);
const PRIVATE_DEV_RETURN_TO_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/;

interface OAuthStatePayload {
  nonce: string;
  return_to?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function buildOAuthState(payload: OAuthStatePayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

export function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(state)) as Partial<OAuthStatePayload>;
    if (!isNonEmptyString(parsed.nonce)) {
      return null;
    }

    // 仅提取仍受支持的字段；旧版 state 中的业务导航信息不再参与登录回调。
    return {
      nonce: parsed.nonce,
      ...(isNonEmptyString(parsed.return_to) ? { return_to: parsed.return_to } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOptionalUrl(value?: string): URL | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedDevReturnTo(url: URL): boolean {
  return PRIVATE_DEV_RETURN_TO_PATTERN.test(url.toString()) && WEB_CALLBACK_PATHS.has(url.pathname);
}

export function buildReturnToCallbackUrl(
  returnTo: string,
  params: { code?: string; error?: string; state: string },
): string | null {
  const returnToUrl = parseOptionalUrl(returnTo);
  if (!returnToUrl || !isTrustedDevReturnTo(returnToUrl) || !isNonEmptyString(params.state)) {
    return null;
  }

  returnToUrl.search = "";
  if (isNonEmptyString(params.code)) {
    returnToUrl.searchParams.set("code", params.code);
  }
  if (isNonEmptyString(params.error)) {
    returnToUrl.searchParams.set("error", params.error);
  }
  returnToUrl.searchParams.set("state", params.state);

  return returnToUrl.toString();
}
