/** CentOS 7 desktop endpoints: keep loopback and private company networks usable. */
export function isPrivateNetworkUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "ws:" &&
    url.protocol !== "wss:"
  ) {
    return [
      "file:",
      "data:",
      "blob:",
      "about:",
      "devtools:",
      "chrome:",
      "chrome-extension:",
      "zcode-browser-restore:",
      "zcode-media:",
    ].includes(url.protocol);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host === "::1" || /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(host)) {
    return true;
  }
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return false;
  }
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** The application may still talk to its own loopback services. */
export function isLoopbackUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    return isPrivateNetworkUrl(input);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** An enterprise DNS name may look public while resolving only to private addresses. */
export async function isPrivateNetworkEndpoint(
  input: string,
  resolveAddresses: (hostname: string) => Promise<string[]>,
): Promise<boolean> {
  if (isPrivateNetworkUrl(input)) return true;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  try {
    const addresses = await resolveAddresses(hostname);
    return (
      addresses.length > 0 &&
      addresses.every((address) =>
        isPrivateNetworkUrl(`http://${address.includes(":") ? `[${address}]` : address}/`),
      )
    );
  } catch {
    return false;
  }
}
