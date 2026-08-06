/**
 * A caller-supplied receipt URL is untrusted input. Without these guards the
 * server will fetch anything it can reach, including localhost, the LAN, and
 * the cloud metadata endpoint.
 */
import { describe, it, expect } from "vitest";
import { assertPublicUrl, isBlockedAddress } from "../../utils/safeFetch.js";

describe("isBlockedAddress", () => {
  it("blocks loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.1.2.3")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks the cloud metadata endpoint", () => {
    // The single most valuable SSRF target on a cloud host.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks CGNAT, multicast and the unspecified address", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
  });

  it("blocks IPv6 link-local and unique-local", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
  });

  it("blocks an IPv4-mapped IPv6 loopback", () => {
    // ::ffff:127.0.0.1 is loopback wearing a different hat.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything it cannot parse rather than guessing", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-HTTP schemes", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com",
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(/only http and https/i);
    }
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });

  it("rejects localhost by name", async () => {
    await expect(assertPublicUrl("http://localhost:8080/x")).rejects.toThrow(
      /local address/
    );
  });

  it("rejects a literal private or loopback address without a DNS lookup", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/x")).rejects.toThrow(/private address/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /private address/
    );
    await expect(assertPublicUrl("http://192.168.0.5/admin")).rejects.toThrow(
      /private address/
    );
  });

  it("rejects a host that does not resolve", async () => {
    await expect(
      assertPublicUrl("https://this-host-should-not-exist.invalid/x")
    ).rejects.toThrow(/Could not resolve host|did not resolve/);
  });

  it("allows a literal public address", async () => {
    const url = await assertPublicUrl("https://1.1.1.1/invoice.pdf");
    expect(url.hostname).toBe("1.1.1.1");
  });
});

describe("debug-log redaction", () => {
  it("redacts secrets by key and by pattern", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");

    const out = _redactForTests({
      client_id: "abc123",
      client_secret: "super-secret-value",
      refresh_token: "rt_livevalue123456",
      access_token: "at_livevalue123456",
      expense: {
        description: "Hotel",
        attachment: { data: "QkFTRTY0", file_name: "receipt.pdf" },
      },
      // A token that arrives under an innocuous key must still be scrubbed.
      message: "Request failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    }) as Record<string, unknown>;

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("super-secret-value");
    expect(serialised).not.toContain("rt_livevalue123456");
    expect(serialised).not.toContain("at_livevalue123456");
    expect(serialised).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialised).not.toContain("QkFTRTY0");

    // Non-sensitive content is still readable, or the log is useless.
    expect(serialised).toContain("Hotel");
    expect(serialised).toContain("receipt.pdf");
  });

  it("omits very long strings rather than dumping a file into the log", async () => {
    const { _redactForTests } = await import("../../services/freeagent.js");
    const out = _redactForTests({ note: "x".repeat(1000) }) as Record<string, string>;
    expect(out["note"]).toMatch(/chars omitted/);
  });
});
