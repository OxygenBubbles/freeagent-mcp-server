/**
 * Resolving a receipt from a path, a URL or inline base64.
 *
 * The inline route is what fails in practice: a screenshot is megabytes of
 * base64 in the tool call and arrives truncated or not at all, so the file
 * routes have to be the ones that work.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlinkSync } from "node:fs";
import {
  checkAttachmentSource,
  hasAttachmentSource,
  resolveAttachmentSource,
  assertReadablePath,
} from "../../utils/attachmentSource.js";

const LIMITS = { maxBase64: 1000, sizeLabel: "~7.5 MB" };

let dir: string;
let receiptPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fa-attach-"));
  receiptPath = join(dir, "receipt.png");
  writeFileSync(receiptPath, Buffer.from("fake png bytes"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("checkAttachmentSource", () => {
  it("accepts no attachment at all", () => {
    expect(checkAttachmentSource({})).toBeNull();
    expect(hasAttachmentSource({})).toBe(false);
  });

  it("accepts a lone filePath — the name comes from the file", () => {
    expect(checkAttachmentSource({ filePath: "/tmp/a.pdf" })).toBeNull();
  });

  it("rejects two sources at once", () => {
    expect(
      checkAttachmentSource({ filePath: "/tmp/a.pdf", fileUrl: "https://x.test/a.pdf" })
    ).toMatch(/at most one/);
  });

  it("rejects base64 with no file name", () => {
    expect(checkAttachmentSource({ fileBase64: "AAAA" })).toMatch(/requires fileName/);
  });

  it("rejects a file name with no file — it would be silently dropped", () => {
    expect(checkAttachmentSource({ fileName: "receipt.pdf" })).toMatch(/no file/);
  });
});

describe("resolveAttachmentSource", () => {
  it("returns nothing when no source is given", async () => {
    expect(await resolveAttachmentSource({}, LIMITS)).toBeUndefined();
  });

  it("reads a local file and infers name and type", async () => {
    const att = await resolveAttachmentSource({ filePath: receiptPath }, LIMITS);
    expect(att?.fileName).toBe("receipt.png");
    expect(att?.contentType).toBe("image/png");
    expect(Buffer.from(att!.fileBase64, "base64").toString()).toBe("fake png bytes");
  });

  it("lets an explicit name and type override the file's own", async () => {
    const att = await resolveAttachmentSource(
      { filePath: receiptPath, fileName: "ionos.pdf", contentType: "application/pdf" },
      LIMITS
    );
    expect(att?.fileName).toBe("ionos.pdf");
    expect(att?.contentType).toBe("application/pdf");
  });

  it("passes inline base64 through", async () => {
    const att = await resolveAttachmentSource(
      { fileBase64: "AAAA", fileName: "receipt.pdf" },
      LIMITS
    );
    expect(att).toEqual({
      fileBase64: "AAAA",
      fileName: "receipt.pdf",
      contentType: "application/pdf",
    });
  });

  it("refuses a file over the limit rather than letting FreeAgent reject it", async () => {
    await expect(
      resolveAttachmentSource({ fileBase64: "A".repeat(1001), fileName: "big.pdf" }, LIMITS)
    ).rejects.toThrow(/too large/);
  });

  it("surfaces a missing local file as an error", async () => {
    await expect(
      resolveAttachmentSource({ filePath: join(dir, "nope.pdf") }, LIMITS)
    ).rejects.toThrow();
  });
});

/**
 * `filePath` asks the server to read a file off its own host, so an unbounded
 * version is an arbitrary-file-read primitive — worst in HTTP mode, where the
 * caller is remote, and under prompt injection, where the model is the caller.
 */
describe("local file path safety", () => {
  const ROOTS = "FREEAGENT_ATTACHMENT_ROOTS";

  afterEach(() => {
    delete process.env[ROOTS];
    delete process.env.PORT;
  });

  it("refuses a relative path, which depends on where the server was started", async () => {
    await expect(assertReadablePath("README.md")).rejects.toThrow(/absolute path/i);
    await expect(
      resolveAttachmentSource({ filePath: "README.md" }, LIMITS)
    ).rejects.toThrow(/absolute path/i);
  });

  it("allows any absolute path when no roots are configured over stdio", async () => {
    expect(await assertReadablePath(receiptPath)).toContain("receipt.png");
  });

  it("refuses local paths in HTTP mode unless roots are set", async () => {
    process.env.PORT = "3000";
    await expect(assertReadablePath(receiptPath)).rejects.toThrow(/HTTP mode/);
  });

  it("allows a path inside a configured root", async () => {
    process.env.PORT = "3000";
    process.env[ROOTS] = dir;
    expect(await assertReadablePath(receiptPath)).toContain("receipt.png");
  });

  it("refuses a path outside every configured root", async () => {
    process.env[ROOTS] = join(dir, "nested-elsewhere");
    await expect(assertReadablePath(receiptPath)).rejects.toThrow(/outside/);
  });

  it("refuses a sibling directory that merely shares a name prefix", async () => {
    const root = join(dir, "allowed");
    mkdirSync(root, { recursive: true });
    const sneaky = join(dir, "allowed-evil");
    mkdirSync(sneaky, { recursive: true });
    const target = join(sneaky, "secret.pdf");
    writeFileSync(target, "x");

    process.env[ROOTS] = root;
    await expect(assertReadablePath(target)).rejects.toThrow(/outside/);
  });

  it("refuses a symlink inside a root that points out of it", async () => {
    const root = join(dir, "linkroot");
    mkdirSync(root, { recursive: true });
    const outside = join(dir, "outside-secret.pdf");
    writeFileSync(outside, "secret");
    const link = join(root, "innocent.pdf");
    symlinkSync(outside, link);

    process.env[ROOTS] = root;
    await expect(assertReadablePath(link)).rejects.toThrow(/outside/);
  });

  it("checks size from the directory entry, before reading the file into memory", async () => {
    const big = join(dir, "big.pdf");
    writeFileSync(big, Buffer.alloc(4096));
    await expect(
      resolveAttachmentSource({ filePath: big }, { maxBase64: 100, sizeLabel: "100 bytes" })
    ).rejects.toThrow(/too large/);
  });
});
