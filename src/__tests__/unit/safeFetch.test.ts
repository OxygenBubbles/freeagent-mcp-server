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

  it("blocks IANA special-use ranges that merely LOOK globally routable", () => {
    // Inside 2000::/3, so a /3 bit-test called these public — but they are
    // routinely routed inside a network, which is what an SSRF wants.
    expect(isBlockedAddress("2001:db8::1")).toBe(true); // documentation
    expect(isBlockedAddress("2001:2::1")).toBe(true); // benchmarking
    expect(isBlockedAddress("2001:20::1")).toBe(true); // ORCHIDv2
    expect(isBlockedAddress("2001:2f::1")).toBe(true); // ORCHIDv2 upper bound
    expect(isBlockedAddress("3fff::1")).toBe(true); // documentation (RFC 9637)
  });

  it("blocks IPv4 special-use ranges", () => {
    for (const ip of [
      "198.18.0.1", "198.19.255.1", // benchmarking
      "192.0.2.5", "198.51.100.5", "203.0.113.5", // TEST-NETs
      "192.0.0.1", // IETF protocol assignments
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("only unwraps the NAT64 well-known /96, not all of 64:ff9b::/32", () => {
    // 64:ff9b:2::808:808 belongs to no defined NAT64 prefix and sits outside
    // global unicast, but a /32-wide match unwrapped its public-looking tail
    // and let it straight through.
    expect(isBlockedAddress("64:ff9b:2::808:808")).toBe(true);
    expect(isBlockedAddress("64:ff9b:1::808:808")).toBe(true);
    expect(isBlockedAddress("64:ff9b::808:808")).toBe(false); // the real /96
  });

  it("blocks the whole of 2001::/23 (IETF protocol assignments)", () => {
    // Enumerating Teredo/benchmarking/ORCHID individually left the rest of
    // the /23 reachable — 2001:100::1 sailed through every exclusion.
    for (const ip of [
      "2001::1", "2001:1::1", "2001:2::1", "2001:3::1",
      "2001:4:112::1", "2001:20::1", "2001:30::1", "2001:100::1", "2001:1ff::1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress("2001:db8::1")).toBe(true); // documentation, outside the /23
  });

  it("leaves real 2001:: allocations reachable", () => {
    // The /23 stops at 2001:01ff::, well below any real assignment.
    expect(isBlockedAddress("2001:200::1")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false); // Google
  });

  it("scopes the 3fff::/20 documentation block to exactly /20", () => {
    // Masking g0 alone implemented 3ff0::/12 and refused 3ff0-3ffe, which is
    // ordinary global unicast.
    expect(isBlockedAddress("3fff::1")).toBe(true);
    expect(isBlockedAddress("3fff:0fff::1")).toBe(true);
    expect(isBlockedAddress("3fff:1000::1")).toBe(false);
    expect(isBlockedAddress("3ff0::1")).toBe(false);
    expect(isBlockedAddress("3ffe::1")).toBe(false);
  });

  it("allows a PUBLIC IPv4 destination wrapped in a transition format", () => {
    // Blanket-refusing these ranges was safe but wrong: it broke public mapped
    // literals and IPv6-only NAT64 networks. Unwrap and judge what they reach.
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("64:ff9b::8.8.8.8")).toBe(false);
  });

  it("allows the real-world IPv6 ranges CDNs actually serve from", () => {
    for (const ip of [
      "2001:4860:4860::8888", // Google
      "2606:4700::1111", // Cloudflare
      "2a00:1450:4009::200e", // Google EU
      "2600:1901::1", // ARIN space
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
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

  it("redacts camelCase and suffix-bearing credential keys", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({
      clientSecret: "LEAK1",
      accessToken: "LEAK2",
      apiKey: "LEAK3",
      session_cookie: "LEAK4",
      secret_url: "https://x/?sig=LEAK5",
      token_id: "LEAK6",
      private_key: "LEAK7",
      stripe_secret_key: "LEAK8",
    });
    const serialised = JSON.stringify(out);
    for (let i = 1; i <= 8; i++) {
      expect(serialised, `LEAK${i}`).not.toContain(`LEAK${i}`);
    }
  });

  it("redacts credential keys that carry no separator at all", async () => {
    // Segment matching alone missed these: "clientsecret" is one segment.
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = JSON.stringify(
      _redactForTests({
        clientsecret: "LEAK1",
        apikey: "LEAK2",
        accesstoken: "LEAK3",
        mypassword: "LEAK4",
      })
    );
    for (let i = 1; i <= 4; i++) expect(out, `LEAK${i}`).not.toContain(`LEAK${i}`);
  });

  it("redacts private-key material by key name and by PEM content", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = JSON.stringify(
      _redactForTests({
        privatekey: "-----BEGIN PRIVATE KEY-----LEAK1",
        privkey: "LEAK2",
        // A PEM block under an innocuous key is still key material.
        note: "-----BEGIN RSA PRIVATE KEY-----LEAK3",
      })
    );
    for (let i = 1; i <= 3; i++) expect(out, `LEAK${i}`).not.toContain(`LEAK${i}`);
  });

  it("does not over-redact words that merely contain a secret word", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({
      secretary_email: "user@example.com",
      passwordless_enabled: true,
    }) as Record<string, unknown>;
    expect(out["secretary_email"]).toBe("user@example.com");
    expect(out["passwordless_enabled"]).toBe(true);
  });

  it("leaves structural keys containing a secret word readable", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({
      foreign_key: "invoices.id",
      idempotency_key: "abc",
      api_key_name: "production",
    }) as Record<string, unknown>;
    expect(out["foreign_key"]).toBe("invoices.id");
    expect(out["api_key_name"]).toBe("production");
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
  it("never routes an untrusted download through a configured proxy", async (ctx) => {
    // With HTTP_PROXY set, axios would dial the PROXY and pass the destination
    // on as an absolute URL — so the lookup guard would validate the proxy
    // while the proxy fetched the private destination for us. proxy:false is
    // the only thing preventing that.
    //
    // The destination below never resolves, so nothing leaves the machine; the
    // assertion is that the proxy was not contacted, which it would have been
    // if the proxy setting were honoured.
    const http = await import("node:http");
    const { fetchUrlAsBase64 } = await import("../../services/freeagent.js");

    let proxyHits = 0;
    const proxy = http.createServer((_req, res) => {
      proxyHits++;
      res.end("intercepted");
    });
    // Some sandboxes deny listen(); the guarantee is still worth asserting
    // where it can be, so skip rather than fail when the socket is refused.
    const listening = await new Promise<boolean>((resolve) => {
      proxy.once("error", () => resolve(false));
      proxy.listen(0, "127.0.0.1", () => resolve(true));
    });
    if (!listening) {
      ctx.skip();
      return;
    }
    const { port } = proxy.address() as { port: number };

    const saved = { ...process.env };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) {
      process.env[key] = `http://127.0.0.1:${port}`;
    }

    try {
      await expect(
        fetchUrlAsBase64("http://receipts.example.invalid/invoice.pdf")
      ).rejects.toThrow();
      expect(proxyHits).toBe(0);
    } finally {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 20_000);
});
