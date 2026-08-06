/**
 * SSRF guards for caller-supplied download URLs.
 *
 * `freeagent_explain_transaction` accepts a `fileUrl` so a receipt can be
 * attached without the model handling raw bytes. That makes the URL untrusted
 * input: without checks it can point the process at localhost, a private LAN
 * address, or a cloud metadata endpoint (169.254.169.254), turning the server
 * into a request proxy for anything it can reach. Redirects have to be checked
 * too, since a public host can redirect to a private one.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Only these schemes are ever fetched. */
const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/**
 * Address ranges that must never be fetched: loopback, link-local (including
 * the cloud metadata address), private RFC1918 space, CGNAT, and the IPv6
 * equivalents.
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // unparseable — refuse rather than guess
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
  // IPv4-mapped (::ffff:127.0.0.1) must be judged on the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true;
}

/**
 * Validate a URL and resolve its host, refusing anything that points at a
 * non-public address. Returns the parsed URL when it is safe to fetch.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Refusing to fetch "${url.protocol}//" — only http and https URLs are allowed.`
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal IP needs no DNS lookup.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(
        `Refusing to fetch ${url.hostname}: it is a loopback, link-local or private address.`
      );
    }
    return url;
  }

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error(`Refusing to fetch ${host}: it resolves to a local address.`);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host "${host}".`);
  }

  if (addresses.length === 0) {
    throw new Error(`Host "${host}" did not resolve to any address.`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `Refusing to fetch ${host}: it resolves to the non-public address ${address}.`
      );
    }
  }

  return url;
}
