/**
 * A caller-supplied receipt URL is untrusted input. Without these guards the
 * server will fetch anything it can reach, including localhost, the LAN, and
 * the cloud metadata endpoint.
 */
import { describe, it, expect } from "vitest";
import {
  assertPublicUrl,
  isBlockedAddress,
  isBlockedHostLiteral,
  expandIPv6,
  guardedLookup,
} from "../../utils/safeFetch.js";

describe("expandIPv6", () => {
  it("expands compressed forms to eight groups", () => {
    expect(expandIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIPv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("folds an embedded IPv4 quad into two hex groups", () => {
    // ::ffff:127.0.0.1 and ::ffff:7f00:1 are the same address; new URL()
    // normalises the first into the second, which a prefix check would miss.
    expect(expandIPv6("::ffff:127.0.0.1")).toEqual(expandIPv6("::ffff:7f00:1"));
  });

  it("strips a zone id", () => {
    expect(expandIPv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("returns null for nonsense", () => {
    for (const bad of ["", "gggg::1", "1:2:3", "1::2::3", "not-an-ip"]) {
      expect(expandIPv6(bad), bad).toBeNull();
    }
  });
});

describe("isBlockedAddress", () => {
  it("blocks loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.1.2.3")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks the cloud metadata endpoint", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918, CGNAT, multicast and the unspecified address", () => {
    for (const ip of [
      "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "100.64.0.1", "224.0.0.1", "0.0.0.0",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks the WHOLE of IPv6 link-local, not just fe80", () => {
    // fe80::/10 spans fe80 through febf. A startsWith("fe80") check let
    // fe90:: through febf:: straight past.
    for (const ip of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 unique-local and multicast", () => {
    for (const ip of ["fc00::1", "fd00::1", "fdff::1", "ff00::1", "ff02::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv4-mapped loopback in BOTH notations", () => {
    // The normalised hex form is what new URL() actually produces.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("blocks IPv4-compatible loopback", () => {
    expect(isBlockedAddress("::127.0.0.1")).toBe(true);
  });

  it("blocks IPv6 transition formats that smuggle a private IPv4 destination", () => {
    // Each of these is a globally-shaped or unusual address carrying a private
    // IPv4 target. Enumerating "bad" prefixes missed all of them; only
    // allowing global unicast, then unwrapping 6to4, catches them.
    expect(isBlockedAddress("::ffff:0:127.0.0.1")).toBe(true); // IPv4-translatable
    expect(isBlockedAddress("64:ff9b::127.0.0.1")).toBe(true); // NAT64
    expect(isBlockedAddress("2002:7f00:1::")).toBe(true); // 6to4 wrapping 127.0.0.1
    expect(isBlockedAddress("2002:c0a8:1::")).toBe(true); // 6to4 wrapping 192.168.0.1
    expect(isBlockedAddress("2002:a9fe:a9fe::")).toBe(true); // 6to4 wrapping metadata
    expect(isBlockedAddress("2001:0:1234::1")).toBe(true); // Teredo
  });

  it("still allows 6to4 wrapping a genuinely public IPv4 address", () => {
    expect(isBlockedAddress("2002:0808:0808::")).toBe(false); // 8.8.8.8
  });

  it("rejects an address with a ':: ' that compresses nothing", () => {
    expect(expandIPv6("1:2:3:4:5:6:7:8::")).toBeNull();
  });

  it("allows ordinary public addresses", () => {
    for (const ip of [
      "1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1",
      "2606:4700::1111", "2001:4860:4860::8888",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything it cannot parse rather than guessing", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("isBlockedHostLiteral", () => {
  it("lets ordinary hostnames through — they are checked at connect time", () => {
    // Regression: treating a hostname as an unparseable address blocked every
    // redirect to a named host, which is most real receipt links.
    for (const host of ["s3.amazonaws.com", "files.stripe.com", "example.com"]) {
      expect(isBlockedHostLiteral(host), host).toBe(false);
    }
  });

  it("still blocks local-only names and bad IP literals", () => {
    for (const host of ["localhost", "foo.localhost", "db.internal", "printer.local", "127.0.0.1"]) {
      expect(isBlockedHostLiteral(host), host).toBe(true);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-HTTP schemes", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
      expect(() => assertPublicUrl(url), url).toThrow(/only http and https/i);
    }
  });

  it("rejects a malformed URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(/Invalid URL/);
  });

  it("rejects localhost by name", () => {
    expect(() => assertPublicUrl("http://localhost:8080/x")).toThrow(/local-only|loopback/);
  });

  it("rejects literal private, loopback and metadata addresses", () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.0.5/admin",
      "http://[::ffff:127.0.0.1]/x",
      "http://[::1]/x",
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow(/loopback|private|link-local/);
    }
  });

  it("allows public hosts and literal public addresses", () => {
    expect(assertPublicUrl("https://1.1.1.1/invoice.pdf").hostname).toBe("1.1.1.1");
    expect(assertPublicUrl("https://files.stripe.com/x.pdf").hostname).toBe(
      "files.stripe.com"
    );
  });
});

describe("guardedLookup", () => {
  it("refuses to hand a private address to the socket", async () => {
    // localhost resolves to 127.0.0.1, so this proves the connect-time guard
    // fires even when the URL check has already passed.
    const err = await new Promise<Error | null>((resolve) => {
      guardedLookup("localhost", { all: false }, (e) => resolve(e as Error | null));
    });
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/non-public address/);
  });

  it("passes a public address through", async () => {
    const result = await new Promise<{ err: Error | null; address: unknown }>((resolve) => {
      guardedLookup("dns.google", { all: false }, (e, address) =>
        resolve({ err: e as Error | null, address })
      );
    });
    // Network-dependent: only assert when resolution actually succeeded.
    if (!result.err) expect(typeof result.address).toBe("string");
  });
});

describe("debug-log redaction", () => {
  it("redacts secrets by key and by pattern", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");

    const out = _redactForTests({
      client_secret: "super-secret-value",
      refresh_token: "rt_livevalue123456",
      expense: {
        description: "Hotel",
        attachment: { data: "QkFTRTY0", file_name: "receipt.pdf" },
      },
      message: "Request failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    }) as Record<string, unknown>;

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("rt_livevalue123456");
    expect(serialised).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialised).not.toContain("QkFTRTY0");

    // Non-sensitive content is still readable, or the log is useless.
    expect(serialised).toContain("Hotel");
    expect(serialised).toContain("receipt.pdf");
  });

  it("does not corrupt legitimate fields whose names merely contain a keyword", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({
      token_count: 42,
      secretary_name: "Jo",
      updated_at: "2026-08-06",
    }) as Record<string, unknown>;
    expect(out["token_count"]).toBe(42);
    expect(out["secretary_name"]).toBe("Jo");
  });

  it("omits very long strings rather than dumping a file into the log", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({ note: "x".repeat(1000) }) as Record<string, string>;
    expect(out["note"]).toMatch(/chars omitted/);
  });
});

describe("proxy handling", () => {
  it("never proxies an untrusted download", async () => {
    // With HTTP_PROXY set, axios dials the PROXY and passes the destination on
    // as an absolute URL — so the lookup guard would validate the proxy and the
    // proxy would fetch the private destination for us. proxy:false is the only
    // thing standing between that and an SSRF.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/services/freeagent.ts", "utf8");
    const fetchFn = source.slice(source.indexOf("export async function fetchUrlAsBase64"));
    const body = fetchFn.slice(0, fetchFn.indexOf("\n}\n"));
    expect(body).toContain("proxy: false");
  });
});
