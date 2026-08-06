/**
 * SSRF guards for caller-supplied download URLs.
 *
 * `freeagent_explain_transaction` accepts a `fileUrl` so a receipt can be
 * attached without the model handling raw bytes. That makes the URL untrusted
 * input: unguarded, it can point the process at localhost, a private LAN
 * address, or a cloud metadata endpoint (169.254.169.254).
 *
 * Two properties matter, and the naive version of this got both wrong:
 *
 *  - Validation must happen on the address actually connected to. Resolving a
 *    hostname, approving it, then letting the HTTP client resolve it again
 *    leaves a DNS-rebinding window where the second answer is private. The
 *    guard is therefore installed as the agents' `lookup`, so the address that
 *    is validated is the address that is dialled.
 *  - IPv6 must be parsed, not string-matched. `new URL()` normalises
 *    `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so a prefix check on the dotted
 *    form misses loopback entirely.
 */

import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

/** Only these schemes are ever fetched. */
export const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

// ── Address classification ───────────────────────────────────────────────────

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // unparseable — refuse rather than guess
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, handling "::" compression
 * and a trailing embedded IPv4 quad. Returns null if it cannot be parsed.
 */
export function expandIPv6(input: string): number[] | null {
  let addr = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (addr.includes("%")) addr = addr.slice(0, addr.indexOf("%")); // drop zone id

  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4) {
    const octets = v4[2]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    addr = `${v4[1]}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseGroups(halves[1] ?? "");
  if (tail === null) return null;

  const missing = 8 - head.length - tail.length;
  // "::" must stand for at least one omitted group, so a full eight groups
  // either side of it is not a valid address.
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/** Render two 16-bit groups as a dotted IPv4 quad. */
function groupsToIPv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Classify an IPv6 address.
 *
 * This is an ALLOWLIST: everything outside global unicast (2000::/3) is
 * refused. Enumerating bad prefixes kept missing things — ::ffff:0:127.0.0.1
 * (IPv4-translatable) and 64:ff9b::127.0.0.1 (NAT64) both carry a private IPv4
 * destination while looking nothing like the classic mapped form. Allowing only
 * global unicast rejects all of those by construction, and the few transition
 * formats that ARE globally shaped are unwrapped and judged on the IPv4 address
 * they embed.
 */
function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (groups === null) return true; // unparseable — refuse

  const [g0, g1, g2, , , , g6, g7] = groups as number[];

  // Anything outside 2000::/3 (global unicast) is refused. That covers ::,
  // ::1, ::ffff:*/96, ::ffff:0:*/96, 64:ff9b::/96, fc00::/7, fe80::/10 and
  // ff00::/8 without needing a rule for each.
  if ((g0! & 0xe000) !== 0x2000) return true;

  // 2002::/16 — 6to4 carries its IPv4 address in the next two groups.
  if (g0 === 0x2002) return isBlockedIPv4(groupsToIPv4(g1!, g2!));

  // 2001:0000::/32 — Teredo tunnelling. The client address is obfuscated in
  // the last two groups; refuse the whole prefix rather than chase it.
  if (g0 === 0x2001 && g1 === 0x0000) return true;

  // Discard-only prefix 100::/64 is outside 2000::/3 and already refused.
  void g6;
  void g7;
  return false;
}

/** True when an IP literal must not be connected to. Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = String(ip ?? "").replace(/^\[|\]$/g, "");
  const version = isIP(bare);
  if (version === 4) return isBlockedIPv4(bare);
  if (version === 6) return isBlockedIPv6(bare);
  // Not an IP literal at all (e.g. a hostname). Callers that may legitimately
  // hold a hostname must use isBlockedHostLiteral instead.
  return true;
}

/**
 * Guard for a host that may legitimately be a NAME rather than an IP.
 *
 * A hostname cannot be judged here — it is validated at connection time by the
 * guarded DNS lookup below, which is the only point where the address actually
 * dialled is known.
 */
export function isBlockedHostLiteral(host: string): boolean {
  const bare = String(host ?? "").replace(/^\[|\]$/g, "");
  if (isIP(bare)) return isBlockedAddress(bare);
  const lower = bare.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".local")
  );
}

// ── URL validation ───────────────────────────────────────────────────────────

export function assertAllowedProtocol(protocol: string, context: string): void {
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    throw new Error(
      `Refusing to fetch ${context}: only http and https URLs are allowed (got "${protocol}").`
    );
  }
}

/**
 * Validate the shape of a URL and reject obviously non-public hosts up front.
 *
 * This is a fast pre-check for clear errors. It is NOT the security boundary —
 * that is the guarded lookup, which runs for every connection including
 * redirect hops.
 */
export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`);
  }

  assertAllowedProtocol(url.protocol, url.href);

  if (isBlockedHostLiteral(url.hostname)) {
    throw new Error(
      `Refusing to fetch ${url.hostname}: it is a loopback, link-local, private or local-only address.`
    );
  }
  return url;
}

// ── Connection-time guard ────────────────────────────────────────────────────

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

/**
 * A DNS lookup that validates whatever it resolves and refuses to hand a
 * non-public address to the socket. Because the HTTP client uses this result
 * directly, there is no window in which a second lookup could return a
 * different (private) answer.
 */
export function guardedLookup(
  hostname: string,
  options: unknown,
  callback: LookupCallback
): void {
  // Node calls lookup(hostname, options, cb) or lookup(hostname, cb).
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts = (typeof options === "function" ? {} : options) as Record<string, unknown>;

  dnsLookup(hostname, opts as never, ((
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family: number
  ) => {
    if (err) return cb(err, address, family);

    const candidates = Array.isArray(address)
      ? address.map((a) => a.address)
      : [address];
    for (const candidate of candidates) {
      if (isBlockedAddress(candidate)) {
        return cb(
          Object.assign(
            new Error(
              `Refusing to connect to ${hostname}: it resolves to the non-public address ${candidate}.`
            ),
            { code: "EBLOCKED" }
          ),
          address,
          family
        );
      }
    }
    cb(null, address, family);
  }) as never);
}

/** HTTP/HTTPS agents whose DNS resolution is guarded. */
export function guardedAgents(): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  return {
    httpAgent: new HttpAgent({ lookup: guardedLookup as never }),
    httpsAgent: new HttpsAgent({ lookup: guardedLookup as never }),
  };
}
