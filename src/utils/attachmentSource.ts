/**
 * Resolving a receipt from whichever source the caller has to hand.
 *
 * Inline base64 is the worst of the three: a screenshot or a scanned invoice
 * runs to megabytes, and a megabyte of base64 in a tool call is unreliable —
 * it gets truncated, or never sent at all, and the expense lands receiptless.
 * filePath and fileUrl move the bytes into the server, so the caller only ever
 * passes a path or a link.
 */

import { readFile, stat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { inferContentType } from "./contentType.js";
import { fetchUrlAsBase64 } from "../services/freeagent.js";

/**
 * Where a local attachment may be read from.
 *
 * `filePath` hands the server a path and asks it to read it, so an unbounded
 * version is an arbitrary-file-read primitive: over stdio it runs as the user
 * and reading their Downloads folder is the point, but in HTTP mode the caller
 * is remote, and a prompt-injected model is a caller too.
 *
 *  - FREEAGENT_ATTACHMENT_ROOTS (colon-separated) confines reads to those
 *    directories, resolved through symlinks. Set it whenever the server is
 *    exposed beyond the local user.
 *  - With no roots configured, HTTP mode (PORT set) refuses local paths
 *    outright; only URLs and inline base64 remain. Stdio keeps working as now.
 */
function allowedRoots(): string[] {
  const raw = process.env.FREEAGENT_ATTACHMENT_ROOTS;
  if (!raw) return [];
  return raw
    .split(":")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => resolve(r));
}

function isHttpMode(): boolean {
  return Boolean(process.env.PORT);
}

/**
 * Resolve a caller-supplied path and refuse anything outside the allowed
 * roots. Symlinks are followed first, so a link inside a root that points out
 * of it is caught rather than followed.
 */
export async function assertReadablePath(filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error(
      `filePath must be an absolute path (got "${filePath}"). Relative paths depend on where the server was started.`
    );
  }

  const roots = allowedRoots();
  if (roots.length === 0 && isHttpMode()) {
    throw new Error(
      "Local file attachments are refused in HTTP mode unless FREEAGENT_ATTACHMENT_ROOTS is set. Pass fileUrl instead."
    );
  }

  // realpath both sides: a symlink into an allowed root, or a root that is
  // itself a link, would otherwise slip past a string comparison.
  const real = await realpath(filePath);
  if (roots.length === 0) return real;

  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => root);
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      return real;
    }
  }
  throw new Error(
    `filePath is outside the directories this server may read (FREEAGENT_ATTACHMENT_ROOTS). Refusing to read "${filePath}".`
  );
}

export interface AttachmentSource {
  fileBase64?: string;
  fileName?: string;
  contentType?: string;
  filePath?: string;
  fileUrl?: string;
}

export interface ResolvedAttachment {
  fileBase64: string;
  fileName: string;
  contentType: string;
}

/** True when the caller asked for an attachment at all. */
export function hasAttachmentSource(args: AttachmentSource): boolean {
  return Boolean(args.fileBase64 || args.filePath || args.fileUrl);
}

/**
 * Cross-field rules the schema cannot express. Returns a message to hand to
 * `invalid()`, or null when the arguments are coherent.
 */
export function checkAttachmentSource(args: AttachmentSource): string | null {
  const sources = [args.fileBase64, args.filePath, args.fileUrl].filter(Boolean);
  if (sources.length > 1) {
    return "Supply at most one of fileBase64, filePath or fileUrl.";
  }
  if (args.fileBase64 && !args.fileName) {
    return "fileBase64 requires fileName — a lone value would be silently dropped.";
  }
  if (args.fileName && sources.length === 0) {
    return "fileName was given with no file — supply fileBase64, filePath or fileUrl too.";
  }
  return null;
}

/**
 * Turn whichever source was supplied into bytes ready for FreeAgent.
 * Returns undefined when no attachment was requested.
 */
export async function resolveAttachmentSource(
  args: AttachmentSource,
  opts: { maxBase64: number; sizeLabel: string }
): Promise<ResolvedAttachment | undefined> {
  if (!hasAttachmentSource(args)) return undefined;

  let fileBase64 = args.fileBase64;
  let fileName = args.fileName;
  let contentType = args.contentType;

  if (!fileBase64 && args.filePath) {
    const real = await assertReadablePath(args.filePath);
    // Check the size from the directory entry first. Reading and then
    // base64-expanding a huge file before testing the limit holds both copies
    // in memory to learn what stat would have said for nothing.
    const { size } = await stat(real);
    const encodedSize = Math.ceil(size / 3) * 4;
    if (encodedSize > opts.maxBase64) {
      throw new Error(
        `File too large to attach (over ${opts.sizeLabel}): ${args.filePath} is ${(size / 1_048_576).toFixed(1)} MB.`
      );
    }
    const buf = await readFile(real);
    fileBase64 = buf.toString("base64");
    fileName = fileName ?? basename(args.filePath);
  }
  if (!fileBase64 && args.fileUrl) {
    const fetched = await fetchUrlAsBase64(args.fileUrl);
    fileBase64 = fetched.base64;
    fileName = fileName ?? fetched.fileName ?? "attachment.pdf";
    contentType = contentType ?? fetched.contentType;
  }
  if (!fileBase64) return undefined;

  if (fileBase64.length > opts.maxBase64) {
    throw new Error(`File too large to attach (over ${opts.sizeLabel}).`);
  }

  const name = fileName ?? "attachment.pdf";
  return {
    fileBase64,
    fileName: name,
    contentType: contentType ?? inferContentType(name),
  };
}
