/**
 * FreeAgent API client with automatic OAuth token refresh.
 *
 * Credentials are read once from env vars on first call and cached.
 * The access token is refreshed automatically when it expires.
 */

import axios, { AxiosError } from "axios";
import {
  FA_API_BASE,
  FA_TOKEN_URL,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_LIST_LIMIT,
} from "../constants.js";
import {
  toMinorUnits,
  fromMinorUnits,
  responseMoneyToMinor,
  requiredResponseMoneyToMinor,
} from "../utils/money.js";
import {
  assertPublicUrl,
  assertAllowedProtocol,
  isBlockedHostLiteral,
  guardedAgents,
} from "../utils/safeFetch.js";
import type {
  FreeAgentToken,
  BankAccount,
  BankTransaction,
  BankTransactionExplanation,
  Attachment,
  Expense,
  ExpenseCategory,
  Project,
  Contact,
  Invoice,
  Bill,
  Task,
  Timeslip,
  TrialBalanceEntry,
  TaxTimelineItem,
} from "../types.js";

// ── Debug logging ─────────────────────────────────────────────────────────────

/**
 * Set FREEAGENT_DEBUG=1 to log outgoing requests and error responses to stderr.
 * Bearer tokens, credentials and base64 file payloads are always redacted.
 */
function debugEnabled(): boolean {
  const v = process.env.FREEAGENT_DEBUG;
  return v === "1" || v === "true";
}

/**
 * Key segments that mean the value is a credential.
 *
 * Matching whole segments rather than substrings keeps `secretary_name` and
 * `token_count` readable, while still catching the many shapes a secret
 * arrives under — api_key, oauth_token, stripe_secret_key, private_key.
 */
const SECRET_SEGMENTS = new Set([
  "secret", "secrets", "password", "passwd", "pwd",
  "token", "tokens", "key", "keys", "apikey",
  "credential", "credentials", "authorization", "auth", "bearer",
  "signature", "sig", "cookie", "cookies", "jwt", "otp", "nonce",
]);

/**
 * Suffixes that make a key metadata ABOUT a secret rather than the secret.
 *
 * Deliberately narrow: `_url` and `_id` are not here, because a signed
 * `secret_url` carries the credential in its query string and a `token_id`
 * is often the token itself.
 */
const METADATA_SUFFIX = /_(count|type|name|at|on|length|size)$/;

/** Keys that contain a secret word but are structural, not sensitive. */
const BENIGN_KEYS = new Set([
  "foreign_key", "primary_key", "sort_key", "partition_key", "idempotency_key",
]);

/**
 * High-signal words matched anywhere in a key, for names that carry no
 * separator at all — "clientsecret" and "apikey" are single segments, so
 * segment matching alone let them through.
 */
const SECRET_SUBSTRINGS = [
  "secret", "password", "passwd", "apikey", "credential", "token",
  // "key" alone is too broad (monkey, keyboard), so the compounds are listed.
  "privatekey", "privkey", "secretkey", "signingkey", "accesskey",
];

/**
 * Words that merely CONTAIN a secret word without being one. Stripped before
 * the substring pass so secretary_email and passwordless_enabled stay in the
 * log — over-redaction is not a security problem, but it does hide state a
 * person is trying to debug.
 */
const BENIGN_SUBSTRINGS = /secretar(y|ies|ial)|passwordless|tokenis|tokeniz/g;

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "data") return true; // base64 attachment payload
  if (BENIGN_KEYS.has(lower)) return false;
  if (METADATA_SUFFIX.test(lower)) return false;
  // Split snake_case, kebab-case, dots AND camelCase, so clientSecret and
  // accessToken are caught alongside client_secret and access_token.
  const segments = lower === key
    ? lower.split(/[_\-.]/)
    : key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.]/);
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true;
  const stripped = lower.replace(BENIGN_SUBSTRINGS, "");
  return SECRET_SUBSTRINGS.some((word) => stripped.includes(word));
}

/** Patterns that look like credentials wherever they appear in a string. */
const SECRET_PATTERNS: RegExp[] = [
  // Everything after a PEM header is key material, so consume to the end of
  // the value rather than stopping lazily at the header.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:access|refresh|api|auth)[_-]?token["'\s:=]+[A-Za-z0-9._~+/-]{8,}/gi,
  /\bclient[_-]?secret["'\s:=]+[A-Za-z0-9._~+/-]{8,}/gi,
];

function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "<redacted>");
  return out;
}

/**
 * Replace secrets and bulky base64 blobs before anything reaches the log.
 *
 * Keys are matched first, but a token can also arrive inside a message body
 * or under an unexpected key, so string values are scrubbed by pattern too.
 */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 256
      ? `<${value.length} chars omitted>`
      : scrubSecrets(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Exact key names only: a substring match redacted ordinary fields
      // such as token_count and secretary_name, making the log misleading.
      if (isSecretKey(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/** Exported for tests — the redaction applied before anything is logged. */
export function _redactForTests(value: unknown): unknown {
  return redact(value);
}

function debugLog(label: string, payload?: unknown): void {
  if (!debugEnabled()) return;
  const suffix = payload === undefined ? "" : ` ${JSON.stringify(redact(payload))}`;
  process.stderr.write(`[freeagent] ${label}${suffix}\n`);
}

// ── Token cache ───────────────────────────────────────────────────────────────

let cachedToken: FreeAgentToken | null = null;
let tokenExpiresAt = 0;
let refreshPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken.access_token;
  }

  // Prevent concurrent refresh races — share a single in-flight promise.
  if (refreshPromise) return refreshPromise;

  refreshPromise = performTokenRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function performTokenRefresh(): Promise<string> {
  const clientId = process.env.FREEAGENT_CLIENT_ID;
  const clientSecret = process.env.FREEAGENT_CLIENT_SECRET;
  const refreshToken = process.env.FREEAGENT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing FreeAgent credentials. Set FREEAGENT_CLIENT_ID, FREEAGENT_CLIENT_SECRET, and FREEAGENT_REFRESH_TOKEN."
    );
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await axios.post<FreeAgentToken>(FA_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });

  cachedToken = response.data;
  tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  return cachedToken.access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function faGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  debugLog(`GET ${path}`, params);
  try {
    const response = await axios.get<T>(`${FA_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      params,
      timeout: 30_000,
    });
    return response.data;
  } catch (err) {
    logResponseError(`GET ${path}`, err);
    throw err;
  }
}

async function faRequest<T>(
  method: "put" | "post",
  path: string,
  body: unknown
): Promise<T> {
  const token = await getAccessToken();
  debugLog(`${method.toUpperCase()} ${path}`, body);
  try {
    const response = await axios[method]<T>(`${FA_API_BASE}${path}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30_000,
    });
    return response.data;
  } catch (err) {
    logResponseError(`${method.toUpperCase()} ${path}`, err);
    throw err;
  }
}

function logResponseError(label: string, err: unknown): void {
  if (!debugEnabled()) return;
  if (err instanceof AxiosError && err.response) {
    debugLog(`${label} -> ${err.response.status}`, err.response.data);
  } else {
    debugLog(`${label} -> ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Pagination ────────────────────────────────────────────────────────────────

/** FreeAgent rejects per_page above this with "Records limited to 100 per page". */
const API_MAX_PER_PAGE = 100;

/** Safety stop so a runaway loop cannot page forever. 100 pages = 10,000 records. */
const MAX_PAGES = 100;

export interface PagedResult<T> {
  items: T[];
  /**
   * True when the caller's limit (or the page ceiling) was reached with a full
   * final page, so FreeAgent may hold more records than were returned. Callers
   * that report totals MUST surface this — a silently truncated total is a
   * wrong number, not a slow one.
   */
  mayHaveMore: boolean;
}

/**
 * Fetch up to `limit` records, following pages until the collection is
 * exhausted. FreeAgent caps a page at 100, so any limit above that needs
 * several requests; asking for 200 in one call just gets a 400.
 */
async function faGetPaged<T>(
  path: string,
  collectionKey: string,
  params: Record<string, unknown>,
  limit: number
): Promise<PagedResult<T>> {
  const items: T[] = [];

  // Fetch one record beyond the caller's limit. Without it, a collection whose
  // size exactly equals the limit reports mayHaveMore: true, and the ageing
  // reports then claim "more than N exist" when N is the whole ledger.
  const probeLimit = limit + 1;

  // per_page MUST stay constant for the whole run: FreeAgent's `page` is an
  // offset in units of per_page, so shrinking the page for a final partial
  // request re-reads the start of the collection instead of continuing it.
  const pageSize = Math.min(API_MAX_PER_PAGE, Math.max(1, probeLimit));

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await faGet<Record<string, unknown>>(path, {
      ...params,
      per_page: pageSize,
      page,
    });
    const batch = Array.isArray(data[collectionKey])
      ? (data[collectionKey] as T[])
      : [];
    items.push(...batch);

    // A short page means the collection is exhausted.
    if (batch.length < pageSize) {
      return { items: items.slice(0, limit), mayHaveMore: items.length > limit };
    }
    // Enough to know whether anything lies beyond the caller's limit.
    if (items.length >= probeLimit) {
      return { items: items.slice(0, limit), mayHaveMore: true };
    }
  }

  // Hit the page ceiling with a full final page — more may well exist.
  return { items: items.slice(0, limit), mayHaveMore: true };
}

function faPut<T>(path: string, body: unknown): Promise<T> {
  return faRequest("put", path, body);
}

function faPost<T>(path: string, body: unknown): Promise<T> {
  return faRequest("post", path, body);
}

async function faDelete(path: string): Promise<void> {
  const token = await getAccessToken();
  debugLog(`DELETE ${path}`);
  try {
    await axios.delete(`${FA_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 30_000,
    });
  } catch (err) {
    logResponseError(`DELETE ${path}`, err);
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractId(entry: { url: string }): string {
  const id = entry.url.split("/").filter(Boolean).pop() ?? "";
  if (!id) {
    throw new Error(`Could not extract ID from FreeAgent URL: "${entry.url}"`);
  }
  return id;
}

/**
 * Turn a FreeAgent resource reference into an absolute API URL.
 *
 * Callers may supply either the full URL ("https://api.freeagent.com/v2/…")
 * or the path form the tool schemas advertise ("/v2/categories/285").
 * FA_API_BASE already ends in "/v2", so a leading "/v2" on the path must be
 * dropped — concatenating blindly produced ".../v2/v2/categories/285", which
 * FreeAgent silently treats as a blank reference ("category can't be blank").
 */
export function toAbsoluteUrl(pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${FA_API_BASE}${path.replace(/^\/v2(?=\/)/, "")}`;
}

/**
 * Guard a caller-supplied record ID before it reaches a URL path. The MCP
 * schemas already constrain these, but the service layer must not depend on
 * its callers having done so.
 */
export function assertNumericId(id: string, label: string): string {
  const trimmed = String(id ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} ID "${id}". Expected digits only.`);
  }
  return trimmed;
}

/**
 * Build a resolver that normalises a reference to an absolute URL for one
 * FreeAgent collection, rejecting references to anything else. Guards against
 * both malformed input and passing (say) a project where a category is wanted.
 */
function makeUrlResolver(collection: string, label: string) {
  const re = new RegExp(`^https://api\\.freeagent\\.com/v2/${collection}/\\d+$`);
  return (pathOrUrl: string): string => {
    const url = toAbsoluteUrl(pathOrUrl);
    if (!re.test(url)) {
      throw new Error(
        `Invalid ${label} "${pathOrUrl}". Expected /v2/${collection}/<id> or the full FreeAgent ${label} URL.`
      );
    }
    return url;
  };
}

export const resolveCategoryUrl = makeUrlResolver("categories", "category");
export const resolveProjectUrl = makeUrlResolver("projects", "project");
export const resolveContactUrl = makeUrlResolver("contacts", "contact");
export const resolveTaskUrl = makeUrlResolver("tasks", "task");
export const resolveUserUrl = makeUrlResolver("users", "user");
export const resolveInvoiceItemUrl = makeUrlResolver("invoice_items", "invoice item");
export const resolveBillItemUrl = makeUrlResolver("bill_items", "bill item");

/**
 * Expense claims are recorded from the claimant's point of view: a negative
 * gross_value is money owed back to them, a positive value is a refund due
 * from them. The tools take a positive amount, so flip the sign here.
 */
export function toExpenseClaimValue(grossValue: string): string {
  // Strict: "22.80xyz" must fail rather than quietly file -22.80.
  const minor = toMinorUnits(grossValue, "gross amount");
  if (minor === 0) {
    throw new Error(`Invalid gross amount "${grossValue}". A claim cannot be zero.`);
  }
  return fromMinorUnits(-Math.abs(minor));
}

// ── Bank accounts ────────────────────────────────────────────────────────────

export async function listBankAccounts(): Promise<BankAccount[]> {
  const data = await faGet<{ bank_accounts: BankAccount[] }>("/bank_accounts");
  return data.bank_accounts ?? [];
}

// ── Bank transactions ────────────────────────────────────────────────────────

export async function listBankTransactions(opts: {
  bankAccountId: string;
  view?: "unexplained" | "explained" | "all" | "marked_for_review" | "manual" | "imported";
  fromDate?: string;
  toDate?: string;
  limit?: number;
  page?: number;
}): Promise<PagedResult<BankTransaction>> {
  const params: Record<string, unknown> = {
    bank_account: `${FA_API_BASE}/bank_accounts/${assertNumericId(
      opts.bankAccountId,
      "bank account"
    )}`,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  let batch: BankTransaction[];
  let mayHaveMore = false;
  if (opts.page !== undefined) {
    // Explicit page: return just that page.
    const data = await faGet<{ bank_transactions: BankTransaction[] }>(
      "/bank_transactions",
      {
        ...params,
        per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        page: opts.page,
      }
    );
    batch = data.bank_transactions ?? [];
    mayHaveMore = batch.length >= Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  } else {
    // No page given: page through so a match beyond the first 100 is still found.
    const paged = await faGetPaged<BankTransaction>(
      "/bank_transactions",
      "bank_transactions",
      params,
      opts.limit ?? DEFAULT_LIST_LIMIT
    );
    batch = paged.items;
    mayHaveMore = paged.mayHaveMore;
  }

  const rows = batch.map((t) => ({
    ...t,
    id: extractId(t),
    bank_transaction_explanations: (t.bank_transaction_explanations ?? []).map((e) => ({
      ...e,
      id: extractId(e),
    })),
  }));

  return { items: rows, mayHaveMore };
}

// ── Explain / update a bank transaction explanation ──────────────────────────

/**
 * Update a bank transaction explanation — set category, description, and/or approve it.
 * All fields are optional; only supplied fields are changed.
 * Pass markExplained=true to approve a "marked for review" transaction.
 */
export async function updateExplanation(opts: {
  explanationId: string;
  description?: string;
  category?: string;
  markExplained?: boolean;
  /** "" clears the project tag. */
  projectUrl?: string;
  /** "" stops the transaction being rebilled. */
  rebillType?: "cost" | "markup" | "price" | "";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  salesTaxRate?: string;
}): Promise<BankTransactionExplanation> {
  const body: Record<string, unknown> = {};
  if (opts.description !== undefined) body["description"] = opts.description;
  if (opts.category !== undefined) {
    body["category"] = resolveCategoryUrl(opts.category);
  }
  if (opts.markExplained) body["marked_for_review"] = false;
  // A bank transaction rebills exactly as an expense does; without these the
  // only way to correct a mis-rebilled payment was the FreeAgent UI.
  if (opts.projectUrl !== undefined) {
    body["project"] = opts.projectUrl === "" ? null : resolveProjectUrl(opts.projectUrl);
  }
  if (opts.rebillType !== undefined) {
    body["rebill_type"] = opts.rebillType === "" ? null : opts.rebillType;
  }
  if (opts.rebillFactor !== undefined) body["rebill_factor"] = opts.rebillFactor;
  if (opts.ecStatus) body["ec_status"] = opts.ecStatus;
  if (opts.salesTaxRate) body["sales_tax_rate"] = opts.salesTaxRate;

  const data = await faPut<{ bank_transaction_explanation: BankTransactionExplanation }>(
    `/bank_transaction_explanations/${opts.explanationId}`,
    { bank_transaction_explanation: body }
  );
  const explanation = data.bank_transaction_explanation;
  return { ...explanation, id: extractId(explanation) };
}

// ── Attachments ──────────────────────────────────────────────────────────────

/**
 * FreeAgent's documented PDF MIME type is "application/x-pdf". It accepts
 * "application/pdf" too (and stores both as "application/pdf"), but the
 * documented value is sent for safety.
 */
export function normalisePdfContentType(contentType: string): string {
  return contentType === "application/pdf" ? "application/x-pdf" : contentType;
}

/**
 * Attach a file (base64) to a bank transaction explanation by including it
 * inline in the PUT body. FreeAgent does not accept a separate POST /attachments
 * for this entity type — the attachment must be sent within the explanation PUT.
 *
 * Returns the updated explanation (which contains the attachment sub-object).
 */
export async function attachToExplanation(opts: {
  explanationId: string;
  fileName: string;
  contentType: string;
  fileBase64: string;
  description?: string;
}): Promise<BankTransactionExplanation> {
  const body = {
    bank_transaction_explanation: {
      attachment: {
        data: opts.fileBase64,
        file_name: opts.fileName,
        content_type: normalisePdfContentType(opts.contentType),
        description: opts.description ?? opts.fileName,
      },
    },
  };
  const data = await faPut<{ bank_transaction_explanation: BankTransactionExplanation }>(
    `/bank_transaction_explanations/${opts.explanationId}`,
    body
  );
  const explanation = data.bank_transaction_explanation;
  return { ...explanation, id: extractId(explanation) };
}

/**
 * Upload a file (base64) as an attachment to an expense.
 * Expenses use the PUT /expenses/:id endpoint with an inline attachment object.
 */
export type AttachableEntity = "bank_transaction_explanation" | "expense" | "bill";

export async function uploadAttachment(opts: {
  entityId: string;
  entityType: AttachableEntity;
  fileName: string;
  contentType: string;
  fileBase64: string;
}): Promise<Attachment> {
  if (opts.entityType === "bank_transaction_explanation") {
    const result = await attachToExplanation({
      explanationId: opts.entityId,
      fileName: opts.fileName,
      contentType: opts.contentType,
      fileBase64: opts.fileBase64,
    });
    const resultWithAtt = result as unknown as { attachment?: Attachment };
    if (!resultWithAtt.attachment) {
      throw new Error("FreeAgent did not return an attachment after upload.");
    }
    return resultWithAtt.attachment;
  }

  // Expenses and bills: PUT the record with an inline attachment.
  const root = opts.entityType;
  const collection = root === "expense" ? "expenses" : "bills";
  const body = {
    [root]: {
      attachment: {
        data: opts.fileBase64,
        file_name: opts.fileName,
        content_type: normalisePdfContentType(opts.contentType),
        description: opts.fileName,
      },
    },
  };
  const data = await faPut<Record<string, { attachment: Attachment }>>(
    `/${collection}/${assertNumericId(opts.entityId, root)}`,
    body
  );
  const attachment = data[root]?.attachment;
  if (!attachment) {
    throw new Error("FreeAgent did not return an attachment after upload.");
  }
  return attachment;
}

/**
 * Replace whatever attachment a record currently has.
 *
 * FreeAgent will not overwrite an attachment via PUT, so the old one has to go
 * first — which means a failed upload leaves the record with nothing. The
 * bytes are resolved by the caller before this is called, so the window is one
 * request wide; if it still fails, say so plainly rather than reporting a bare
 * upload error that reads as "nothing happened".
 */
export async function replaceAttachment(opts: {
  entityId: string;
  entityType: AttachableEntity;
  fileName: string;
  contentType: string;
  fileBase64: string;
}): Promise<{ attachment: Attachment; replaced: boolean }> {
  const replaced = await deleteExistingAttachment(opts.entityId, opts.entityType).catch(
    () => false
  );
  try {
    const attachment = await uploadAttachment(opts);
    return { attachment, replaced };
  } catch (err) {
    if (replaced) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Uploading ${opts.fileName} failed AFTER the previous attachment was deleted, so the ` +
        `${opts.entityType} now has no attachment. Re-attach it. Underlying error: ${detail}`
      );
    }
    throw err;
  }
}

/** The collection each attachable record lives in. */
const ATTACHABLE_COLLECTIONS: Record<AttachableEntity, string> = {
  bank_transaction_explanation: "bank_transaction_explanations",
  expense: "expenses",
  bill: "bills",
};

/**
 * Remove the attachment currently on a record, if any.
 *
 * FreeAgent rejects overwriting an attachment via PUT, so the old one must be
 * deleted before attaching a replacement. Returns true if one was removed.
 */
export async function deleteExistingAttachment(
  entityId: string,
  entityType: AttachableEntity = "bank_transaction_explanation"
): Promise<boolean> {
  const collection = ATTACHABLE_COLLECTIONS[entityType];
  const data = await faGet<Record<string, { attachment?: { url: string } }>>(
    `/${collection}/${assertNumericId(entityId, entityType)}`
  );
  const att = data[entityType]?.attachment;
  if (!att?.url) return false;
  const attId = att.url.split("/").filter(Boolean).pop();
  await faDelete(`/attachments/${attId}`);
  return true;
}

/** Attachments are capped well below FreeAgent's own limit. */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Download a file from a URL and return it base64-encoded, so a receipt PDF
 * (e.g. a Stripe "Download invoice" link) can be attached without the caller
 * ever handling the raw bytes.
 *
 * The URL is untrusted input, so the host is checked before the request and
 * again on every redirect: a public hostname can otherwise redirect to
 * localhost or a cloud metadata endpoint. The response is also size-capped —
 * an unbounded download is buffered twice (raw plus base64) and would be an
 * easy way to exhaust memory.
 */
export async function fetchUrlAsBase64(
  url: string
): Promise<{ base64: string; fileName?: string; contentType?: string }> {
  assertPublicUrl(url);

  const { httpAgent, httpsAgent } = guardedAgents();

  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
    maxRedirects: 5,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    // Every connection, including each redirect hop, resolves through a lookup
    // that refuses non-public addresses — so the address validated is the
    // address dialled, closing the rebinding window.
    httpAgent,
    httpsAgent,
    // Never proxy an untrusted URL. With HTTP_PROXY/HTTPS_PROXY/ALL_PROXY set,
    // axios dials the PROXY and passes the destination on as an absolute URL,
    // so the guarded lookup would validate the proxy and the proxy would
    // happily fetch the private destination on our behalf.
    proxy: false,
    // A redirect target is a HOSTNAME, not an IP, so it cannot be judged as an
    // address here. Only the scheme and any literal-IP host are checked; names
    // are handled by the guarded lookup above.
    beforeRedirect: (options) => {
      const host = String(options.hostname ?? "");
      assertAllowedProtocol(
        String(options.protocol ?? ""),
        `redirect target ${host}`
      );
      if (isBlockedHostLiteral(host)) {
        throw new Error(
          `Refusing to follow a redirect to ${host}: it is a loopback, link-local, private or local-only address.`
        );
      }
    },
  });

  const byteLength = (resp.data as ArrayBuffer).byteLength ?? 0;
  if (byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Downloaded file is ${Math.round(byteLength / 1_048_576)} MB, above the ${
        MAX_DOWNLOAD_BYTES / 1_048_576
      } MB limit.`
    );
  }

  const base64 = Buffer.from(resp.data).toString("base64");
  let fileName: string | undefined;
  const cd = resp.headers["content-disposition"];
  if (typeof cd === "string") {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    if (m) fileName = decodeURIComponent(m[1].replace(/"$/, ""));
  }
  const rawCt = resp.headers["content-type"];
  const contentType = typeof rawCt === "string" ? rawCt.split(";")[0].trim() : undefined;
  return { base64, fileName, contentType };
}

// ── Categories ───────────────────────────────────────────────────────────────

let cachedCategories: ExpenseCategory[] | null = null;
let categoriesCachedAt = 0;

/**
 * How long the chart of accounts and the current user are cached.
 *
 * The server is long-lived (the desktop app keeps it running for days), so an
 * indefinite cache hides a category added in FreeAgent until a restart.
 */
const REFERENCE_CACHE_TTL_MS = 15 * 60_000;

/**
 * GET /v2/categories does not return a flat "categories" array — it returns
 * four parallel arrays, one per category type. Reading `data.categories`
 * always yielded an empty list.
 */
const CATEGORY_GROUP_KEYS = [
  "admin_expenses_categories",
  "cost_of_sales_categories",
  "income_categories",
  "general_categories",
] as const;

export async function listCategories(): Promise<ExpenseCategory[]> {
  if (cachedCategories && Date.now() - categoriesCachedAt < REFERENCE_CACHE_TTL_MS) {
    return cachedCategories;
  }
  const data = await faGet<Record<string, unknown>>("/categories");

  const flattened: ExpenseCategory[] = [];
  for (const key of CATEGORY_GROUP_KEYS) {
    const group = data[key];
    if (!Array.isArray(group)) continue;
    for (const raw of group as ExpenseCategory[]) {
      flattened.push({ ...raw, category_type: key });
    }
  }

  // Tolerate a flat "categories" array in case FreeAgent ever returns one.
  if (flattened.length === 0 && Array.isArray(data["categories"])) {
    flattened.push(...(data["categories"] as ExpenseCategory[]));
  }

  cachedCategories = flattened;
  categoriesCachedAt = Date.now();
  return cachedCategories;
}

/** Exported for tests — clears the module-level category cache. */
export function _resetCategoryCache(): void {
  cachedCategories = null;
  categoriesCachedAt = 0;
}

// ── Users ────────────────────────────────────────────────────────────────────

let cachedUserUrl: string | null = null;
let cachedUserAt = 0;
let cachedUserKey = "";

/** Identifies the credentials a cached value belongs to, without storing them. */
function credentialFingerprint(): string {
  const token = process.env.FREEAGENT_REFRESH_TOKEN ?? "";
  const id = process.env.FREEAGENT_CLIENT_ID ?? "";
  // Length + last 4 chars is enough to notice a change; the secret is not kept.
  return `${id.length}:${token.length}:${token.slice(-4)}`;
}

/**
 * The URL of the authenticated user. FreeAgent requires `user` on every
 * expense — omitting it is rejected with "user can't be blank".
 */
export async function getCurrentUserUrl(): Promise<string> {
  const key = credentialFingerprint();
  if (
    cachedUserUrl &&
    cachedUserKey === key &&
    Date.now() - cachedUserAt < REFERENCE_CACHE_TTL_MS
  ) {
    return cachedUserUrl;
  }
  const data = await faGet<{ user?: { url?: string } }>("/users/me");
  const url = data.user?.url;
  if (!url) {
    throw new Error("FreeAgent did not return a user URL from /users/me.");
  }
  cachedUserUrl = url;
  cachedUserAt = Date.now();
  cachedUserKey = key;
  return url;
}

/** Exported for tests — clears the module-level user cache. */
export function _resetUserCache(): void {
  cachedUserUrl = null;
  cachedUserAt = 0;
  cachedUserKey = "";
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(
  view?: "active" | "completed" | "cancelled" | "all",
  limit = DEFAULT_LIST_LIMIT
): Promise<PagedResult<Project>> {
  const params: Record<string, unknown> = {};
  if (view && view !== "all") params["view"] = view;
  const { items, mayHaveMore } = await faGetPaged<Project>(
    "/projects",
    "projects",
    params,
    limit
  );
  return { items: items.map((p) => ({ ...p, id: extractId(p) })), mayHaveMore };
}

export async function getProject(projectId: string): Promise<Project> {
  const id = assertNumericId(projectId, "project");
  const data = await faGet<{ project: Project }>(`/projects/${id}`);
  return { ...data.project, id: extractId(data.project) };
}

export interface ProjectInput {
  contactUrl: string;
  name: string;
  currency?: string;
  budget?: number;
  budgetUnits?: "Hours" | "Days" | "Monetary";
  status?: "Active" | "Completed" | "Cancelled" | "Hidden";
  usesProjectInvoiceSequence?: boolean;
  normalBillingRate?: string;
  billingPeriod?: "hour" | "day";
  hoursPerDay?: number;
  contractPoReference?: string;
  startsOn?: string;
  endsOn?: string;
  isIr35?: boolean;
  includeUnbilledTimeInProfitability?: boolean;
}

/**
 * Build the POST /v2/projects request body.
 *
 * FreeAgent requires currency, budget, budget_units and
 * uses_project_invoice_sequence as well as the name and contact. They are
 * optional here and defaulted, so the common case — "a project for this
 * client" — does not need six arguments to say it.
 */
export function buildProjectBody(opts: ProjectInput): { project: Record<string, unknown> } {
  if (!opts.name?.trim()) throw new Error("A project needs a name.");

  const project: Record<string, unknown> = {
    contact: resolveContactUrl(opts.contactUrl),
    name: opts.name,
    currency: opts.currency ?? "GBP",
    budget: opts.budget ?? 0,
    budget_units: opts.budgetUnits ?? "Hours",
    status: opts.status ?? "Active",
    uses_project_invoice_sequence: opts.usesProjectInvoiceSequence ?? false,
  };

  if (opts.normalBillingRate !== undefined) {
    project["normal_billing_rate"] = opts.normalBillingRate;
  }
  if (opts.billingPeriod) project["billing_period"] = opts.billingPeriod;
  if (opts.hoursPerDay !== undefined) project["hours_per_day"] = opts.hoursPerDay;
  if (opts.contractPoReference) {
    project["contract_po_reference"] = opts.contractPoReference;
  }
  if (opts.startsOn) project["starts_on"] = opts.startsOn;
  if (opts.endsOn) project["ends_on"] = opts.endsOn;
  if (opts.isIr35 !== undefined) project["is_ir35"] = opts.isIr35;
  if (opts.includeUnbilledTimeInProfitability !== undefined) {
    project["include_unbilled_time_in_profitability"] =
      opts.includeUnbilledTimeInProfitability;
  }

  return { project };
}

export async function createProject(opts: ProjectInput): Promise<Project> {
  const data = await faPost<{ project: Project }>("/projects", buildProjectBody(opts));
  return { ...data.project, id: extractId(data.project) };
}

/**
 * Build the PUT /v2/projects/:id body — named fields only, so an update
 * cannot reset the budget or status the caller never mentioned.
 */
export function buildProjectUpdateBody(opts: Partial<ProjectInput>): {
  project: Record<string, unknown>;
} {
  const project: Record<string, unknown> = {};
  if (opts.contactUrl) project["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.name) project["name"] = opts.name;
  if (opts.currency) project["currency"] = opts.currency;
  if (opts.budget !== undefined) project["budget"] = opts.budget;
  if (opts.budgetUnits) project["budget_units"] = opts.budgetUnits;
  if (opts.status) project["status"] = opts.status;
  if (opts.usesProjectInvoiceSequence !== undefined) {
    project["uses_project_invoice_sequence"] = opts.usesProjectInvoiceSequence;
  }
  if (opts.normalBillingRate !== undefined) {
    project["normal_billing_rate"] = opts.normalBillingRate;
  }
  if (opts.billingPeriod) project["billing_period"] = opts.billingPeriod;
  if (opts.hoursPerDay !== undefined) project["hours_per_day"] = opts.hoursPerDay;
  if (opts.contractPoReference !== undefined) {
    project["contract_po_reference"] = opts.contractPoReference;
  }
  if (opts.startsOn) project["starts_on"] = opts.startsOn;
  if (opts.endsOn) project["ends_on"] = opts.endsOn;
  if (opts.isIr35 !== undefined) project["is_ir35"] = opts.isIr35;
  if (opts.includeUnbilledTimeInProfitability !== undefined) {
    project["include_unbilled_time_in_profitability"] =
      opts.includeUnbilledTimeInProfitability;
  }

  if (Object.keys(project).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { project };
}

export async function updateProject(
  projectId: string,
  opts: Partial<ProjectInput>
): Promise<Project> {
  const id = assertNumericId(projectId, "project");
  const data = await faPut<{ project: Project }>(
    `/projects/${id}`,
    buildProjectUpdateBody(opts)
  );
  return { ...data.project, id: extractId(data.project) };
}

export async function deleteProject(projectId: string): Promise<void> {
  await faDelete(`/projects/${assertNumericId(projectId, "project")}`);
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export interface ExpenseAttachmentInput {
  fileName: string;
  contentType: string;
  fileBase64: string;
  description?: string;
}

/**
 * VAT treatment FreeAgent files the purchase or sale under. Omitted, it
 * defaults to UK/Non-EC.
 */
export type EcStatus = "UK/Non-EC" | "EC Goods" | "EC Services" | "Reverse Charge";

/**
 * Build the POST /v2/expenses request body.
 *
 * Split out from the request so the documented shape can be unit-tested
 * without touching the network.
 */
export function buildExpenseBody(opts: {
  categoryUrl: string;
  datedOn: string;
  description: string;
  grossValue: string;
  userUrl: string;
  currency?: string;
  salesTaxRate?: string;
  manualSalesTaxAmount?: string;
  receiptReference?: string;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  attachment?: ExpenseAttachmentInput;
}): { expense: Record<string, unknown> } {
  const expense: Record<string, unknown> = {
    user: opts.userUrl,
    category: resolveCategoryUrl(opts.categoryUrl),
    dated_on: opts.datedOn,
    description: opts.description,
    gross_value: toExpenseClaimValue(opts.grossValue),
    currency: opts.currency ?? "GBP",
  };

  if (opts.salesTaxRate) expense["sales_tax_rate"] = opts.salesTaxRate;
  if (opts.manualSalesTaxAmount) {
    expense["manual_sales_tax_amount"] = opts.manualSalesTaxAmount;
  }
  if (opts.receiptReference) expense["receipt_reference"] = opts.receiptReference;
  if (opts.projectUrl) expense["project"] = resolveProjectUrl(opts.projectUrl);
  // Tagging a project attributes the cost to it; without rebill_type the
  // expense is never queued to bill on, which reads as "rebilled" but isn't.
  if (opts.rebillType) expense["rebill_type"] = opts.rebillType;
  if (opts.rebillFactor) expense["rebill_factor"] = opts.rebillFactor;
  // Left unset, FreeAgent files the purchase as UK/Non-EC — so an overseas
  // or reverse-charge supplier lands on the VAT return under the wrong box.
  if (opts.ecStatus) expense["ec_status"] = opts.ecStatus;
  if (opts.attachment) {
    expense["attachment"] = {
      data: opts.attachment.fileBase64,
      file_name: opts.attachment.fileName,
      content_type: normalisePdfContentType(opts.attachment.contentType),
      description: opts.attachment.description ?? opts.attachment.fileName,
    };
  }

  return { expense };
}

export async function createExpense(opts: {
  categoryUrl: string;
  datedOn: string;
  description: string;
  grossValue: string;
  currency?: string;
  salesTaxRate?: string;
  manualSalesTaxAmount?: string;
  receiptReference?: string;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  userUrl?: string;
  attachment?: ExpenseAttachmentInput;
}): Promise<Expense> {
  // Validate caller input before spending a round-trip on /users/me.
  resolveCategoryUrl(opts.categoryUrl);
  if (opts.projectUrl) resolveProjectUrl(opts.projectUrl);
  toExpenseClaimValue(opts.grossValue);

  const userUrl = opts.userUrl ?? (await getCurrentUserUrl());
  const body = buildExpenseBody({ ...opts, userUrl });

  const data = await faPost<{ expense: Expense }>("/expenses", body);
  const expense = data.expense;
  return { ...expense, id: extractId(expense) };
}

/**
 * List expenses.
 *
 * FreeAgent publishes no "unbilled" view for expenses — only `recent` and
 * `recurring` — so the rebillable/unbilled split is computed by the caller
 * from `rebilled_on_invoice`, which the API sets once a cost has been billed on.
 */
export async function listExpenses(opts: {
  fromDate?: string;
  toDate?: string;
  view?: "all" | "recent" | "recurring";
  projectUrl?: string;
  userUrl?: string;
  updatedSince?: string;
  limit?: number;
} = {}): Promise<PagedResult<Expense>> {
  const params: Record<string, unknown> = {};
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.userUrl) params["user"] = resolveUserUrl(opts.userUrl);
  if (opts.updatedSince) params["updated_since"] = opts.updatedSince;

  const { items, mayHaveMore } = await faGetPaged<Expense>(
    "/expenses",
    "expenses",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((e) => ({ ...e, id: extractId(e) })), mayHaveMore };
}

// ── Mileage expenses ─────────────────────────────────────────────────────────

export type VehicleType = "Car" | "Motorcycle" | "Bicycle";

/**
 * Mileage is a special expense category. FreeAgent requires `mileage` and
 * `vehicle_type` on it and computes gross_value itself from the account's
 * configured mileage rate — sending a gross_value instead is rejected with
 * "mileage is not a number; vehicle_type is unrecognised".
 */
export function buildMileageExpenseBody(opts: {
  userUrl: string;
  categoryUrl: string;
  datedOn: string;
  description: string;
  miles: number;
  vehicleType: VehicleType;
  currency?: string;
  engineType?: string;
  engineSize?: string;
  haveVatReceipt?: boolean;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
}): { expense: Record<string, unknown> } {
  const expense: Record<string, unknown> = {
    user: opts.userUrl,
    category: resolveCategoryUrl(opts.categoryUrl),
    dated_on: opts.datedOn,
    description: opts.description,
    mileage: opts.miles,
    vehicle_type: opts.vehicleType,
    reclaim_mileage: 1,
    currency: opts.currency ?? "GBP",
  };
  // Engine type and size drive the VAT that can be reclaimed on the fuel
  // element of a mileage claim; without them FreeAgent has nothing to work from.
  if (Boolean(opts.engineType) !== Boolean(opts.engineSize)) {
    throw new Error(
      "engineType and engineSize go together — FreeAgent needs both to work out the VAT on the fuel."
    );
  }
  if (opts.haveVatReceipt && !opts.engineType) {
    throw new Error(
      "haveVatReceipt needs engineType and engineSize — without them FreeAgent cannot calculate the reclaimable VAT, and recording the receipt alone achieves nothing."
    );
  }
  if (opts.engineType) expense["engine_type"] = opts.engineType;
  if (opts.engineSize) expense["engine_size"] = opts.engineSize;
  if (opts.haveVatReceipt !== undefined) {
    expense["have_vat_receipt"] = opts.haveVatReceipt;
  }
  if (opts.projectUrl) expense["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.rebillType) expense["rebill_type"] = opts.rebillType;
  if (opts.rebillFactor) expense["rebill_factor"] = opts.rebillFactor;
  return { expense };
}

export async function createMileageExpense(opts: {
  categoryUrl: string;
  datedOn: string;
  description: string;
  miles: number;
  vehicleType: VehicleType;
  currency?: string;
  engineType?: string;
  engineSize?: string;
  haveVatReceipt?: boolean;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
  userUrl?: string;
}): Promise<Expense> {
  resolveCategoryUrl(opts.categoryUrl);
  if (opts.projectUrl) resolveProjectUrl(opts.projectUrl);
  if (!Number.isFinite(opts.miles) || opts.miles <= 0) {
    throw new Error(`Invalid mileage "${opts.miles}". Expected a positive number of miles.`);
  }

  const userUrl = opts.userUrl ?? (await getCurrentUserUrl());
  const body = buildMileageExpenseBody({ ...opts, userUrl });

  const data = await faPost<{ expense: Expense }>("/expenses", body);
  const expense = data.expense;
  return { ...expense, id: extractId(expense) };
}

// ── Mileage settings ─────────────────────────────────────────────────────────

/**
 * The rate FreeAgent will actually apply to a mileage claim.
 *
 * The tool used to estimate the claim from MILEAGE_RATE_PENCE or the built-in
 * HMRC bands and then report the difference after filing. FreeAgent knows the
 * answer up front, so ask it.
 */
export interface MileageRate {
  /** Pence per mile below the annual threshold. */
  initialRatePence: number;
  /** Pence per mile above it — equal to the initial rate when there is no band. */
  subsequentRatePence?: number;
  /** Miles per tax year at which the rate steps down, when there is a band. */
  thresholdMiles?: number;
}

let cachedMileageSettings: Record<string, unknown> | null = null;
let mileageSettingsCachedAt = 0;
// Concurrent misses share one request: filing several journeys at once would
// otherwise fire an identical fetch per claim.
let mileageSettingsInFlight: Promise<Record<string, unknown>> | null = null;

export function _resetMileageSettingsCache(): void {
  cachedMileageSettings = null;
  mileageSettingsCachedAt = 0;
  mileageSettingsInFlight = null;
}

export async function getMileageSettings(): Promise<Record<string, unknown>> {
  const fresh =
    cachedMileageSettings &&
    Date.now() - mileageSettingsCachedAt < REFERENCE_CACHE_TTL_MS;
  if (fresh) return cachedMileageSettings as Record<string, unknown>;
  if (mileageSettingsInFlight) return mileageSettingsInFlight;

  mileageSettingsInFlight = (async () => {
    try {
      const data = await faGet<{ mileage_settings?: Record<string, unknown> }>(
        "/expenses/mileage_settings"
      );
      cachedMileageSettings = data.mileage_settings ?? {};
      mileageSettingsCachedAt = Date.now();
      return cachedMileageSettings;
    } finally {
      // Cleared on failure too, so one bad response does not poison the next
      // lookup with a rejected promise.
      mileageSettingsInFlight = null;
    }
  })();
  return mileageSettingsInFlight;
}

/** A rate may be quoted in pounds per mile (0.45) or pence (45). */
function toPence(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 5 ? Math.round(n * 100) : Math.round(n);
}

/** Pick the entry whose from/to window contains the date. */
function entryForDate(entries: unknown, datedOn: string): Record<string, unknown> | undefined {
  if (!Array.isArray(entries)) return undefined;
  const dated = entries.filter(
    (e): e is Record<string, unknown> => Boolean(e) && typeof e === "object"
  );
  // No fallback to the newest entry: applying next year's rate to last year's
  // journey is a wrong answer, and the caller's own rates are a better one.
  return dated.find((e) => {
    const from = typeof e["from"] === "string" ? (e["from"] as string) : undefined;
    const to = typeof e["to"] === "string" ? (e["to"] as string) : undefined;
    return (!from || from <= datedOn) && (!to || to >= datedOn);
  });
}

/**
 * The published rate for a vehicle on a date, or null when FreeAgent's answer
 * cannot be read.
 *
 * The payload is a list of date-ranged settings whose inner shape has changed
 * before now, so every lookup is defensive: anything unrecognised returns null
 * and the caller falls back to its own configured rates rather than filing a
 * claim against a number that was guessed from a half-understood payload.
 */
export async function getMileageRate(
  datedOn: string,
  vehicleType: VehicleType
): Promise<MileageRate | null> {
  let settings: Record<string, unknown>;
  try {
    settings = await getMileageSettings();
  } catch {
    return null;
  }

  const entry = entryForDate(settings["mileage_rates"], datedOn);
  const value = entry?.["value"];
  if (!value || typeof value !== "object") return null;

  // The vehicle key is "car" / "Car" / "cars" depending on the payload version.
  const wanted = vehicleType.toLowerCase();
  const record = value as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase().replace(/s$/, "") === wanted);
  if (!key) return null;

  const forVehicle = record[key];
  if (typeof forVehicle === "number" || typeof forVehicle === "string") {
    const rate = toPence(forVehicle);
    return rate === undefined ? null : { initialRatePence: rate };
  }
  if (!forVehicle || typeof forVehicle !== "object") return null;

  const band = forVehicle as Record<string, unknown>;
  const initial = toPence(
    band["initial_rate"] ?? band["initial_rate_mileage"] ?? band["rate"] ?? band["basic_rate"]
  );
  if (initial === undefined) return null;

  const subsequent = toPence(
    band["subsequent_rate"] ?? band["secondary_rate"] ?? band["higher_rate"]
  );
  const rawThreshold =
    band["threshold"] ?? band["threshold_miles"] ?? band["initial_rate_threshold"];
  const threshold =
    typeof rawThreshold === "string" ? Number(rawThreshold) : (rawThreshold as number);

  return {
    initialRatePence: initial,
    subsequentRatePence: subsequent,
    thresholdMiles: Number.isFinite(threshold) && threshold > 0 ? threshold : undefined,
  };
}

/** Link an expense to a bank transaction by creating a new explanation. */
export async function linkExpenseToEntry(opts: {
  entryId: string;
  expenseUrl: string;
}): Promise<BankTransactionExplanation> {
  const body = {
    bank_transaction_explanation: {
      bank_transaction: `${FA_API_BASE}/bank_transactions/${opts.entryId}`,
      type: "Expense",
      expense: opts.expenseUrl,
    },
  };

  const data = await faPost<{ bank_transaction_explanation: BankTransactionExplanation }>(
    "/bank_transaction_explanations",
    body
  );
  const explanation = data.bank_transaction_explanation;
  return { ...explanation, id: extractId(explanation) };
}

export interface ExpenseUpdate {
  categoryUrl?: string;
  datedOn?: string;
  description?: string;
  grossValue?: string;
  currency?: string;
  salesTaxRate?: string;
  manualSalesTaxAmount?: string;
  receiptReference?: string;
  /** "" clears the project tag. */
  projectUrl?: string;
  /** "" stops the expense being rebilled. */
  rebillType?: "cost" | "markup" | "price" | "";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  attachment?: ExpenseAttachmentInput;
}

/**
 * Build the PUT /v2/expenses/:id body.
 *
 * Only the fields the caller named are sent: a PUT that echoed every field
 * would overwrite whatever else had been set on the expense in the meantime.
 */
export function buildExpenseUpdateBody(opts: ExpenseUpdate): {
  expense: Record<string, unknown>;
} {
  const expense: Record<string, unknown> = {};

  if (opts.categoryUrl) expense["category"] = resolveCategoryUrl(opts.categoryUrl);
  if (opts.datedOn) expense["dated_on"] = opts.datedOn;
  if (opts.description !== undefined) expense["description"] = opts.description;
  if (opts.grossValue) expense["gross_value"] = toExpenseClaimValue(opts.grossValue);
  if (opts.currency) expense["currency"] = opts.currency;
  if (opts.salesTaxRate) expense["sales_tax_rate"] = opts.salesTaxRate;
  if (opts.manualSalesTaxAmount) {
    expense["manual_sales_tax_amount"] = opts.manualSalesTaxAmount;
  }
  if (opts.receiptReference) expense["receipt_reference"] = opts.receiptReference;
  // An empty string clears the field: FreeAgent takes null, and without this
  // an expense could be tagged to a project but never untagged.
  if (opts.projectUrl !== undefined) {
    expense["project"] = opts.projectUrl === "" ? null : resolveProjectUrl(opts.projectUrl);
  }
  if (opts.rebillType !== undefined) {
    expense["rebill_type"] = opts.rebillType === "" ? null : opts.rebillType;
  }
  if (opts.rebillFactor) expense["rebill_factor"] = opts.rebillFactor;
  if (opts.ecStatus) expense["ec_status"] = opts.ecStatus;
  if (opts.attachment) {
    expense["attachment"] = {
      data: opts.attachment.fileBase64,
      file_name: opts.attachment.fileName,
      content_type: normalisePdfContentType(opts.attachment.contentType),
      description: opts.attachment.description ?? opts.attachment.fileName,
    };
  }

  if (Object.keys(expense).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }

  return { expense };
}

export async function updateExpense(
  expenseId: string,
  opts: ExpenseUpdate
): Promise<Expense> {
  const id = assertNumericId(expenseId, "expense");
  const body = buildExpenseUpdateBody(opts);
  const data = await faPut<{ expense: Expense }>(`/expenses/${id}`, body);
  const expense = data.expense;
  return { ...expense, id: extractId(expense) };
}

export async function deleteExpense(expenseId: string): Promise<void> {
  await faDelete(`/expenses/${assertNumericId(expenseId, "expense")}`);
}

export async function getExpense(expenseId: string): Promise<Expense> {
  const id = assertNumericId(expenseId, "expense");
  const data = await faGet<{ expense: Expense }>(`/expenses/${id}`);
  return { ...data.expense, id: extractId(data.expense) };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function listContacts(opts: {
  view?: "all" | "active" | "clients" | "suppliers" | "hidden";
  limit?: number;
} = {}): Promise<PagedResult<Contact>> {
  const params: Record<string, unknown> = {};
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  const { items, mayHaveMore } = await faGetPaged<Contact>(
    "/contacts",
    "contacts",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((c) => ({ ...c, id: extractId(c) })), mayHaveMore };
}

export interface ContactInput {
  organisationName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  address1?: string;
  address2?: string;
  town?: string;
  region?: string;
  postcode?: string;
  country?: string;
  contactNameOnInvoices?: boolean;
  chargeSalesTax?: "Auto" | "Always" | "Never";
  salesTaxRegistrationNumber?: string;
  defaultPaymentTermsInDays?: number;
  status?: "Active" | "Hidden";
  /** Internal: on update, an empty string clears the field instead of being dropped. */
  clearEmpty?: boolean;
}

export function buildContactBody(opts: ContactInput): { contact: Record<string, unknown> } {
  if (!opts.organisationName && !opts.firstName && !opts.lastName) {
    throw new Error(
      "A contact needs either an organisation name or a first/last name."
    );
  }
  const contact: Record<string, unknown> = {};
  const map: Array<[string, unknown]> = [
    ["organisation_name", opts.organisationName],
    ["first_name", opts.firstName],
    ["last_name", opts.lastName],
    ["email", opts.email],
    ["phone_number", opts.phoneNumber],
    ["address1", opts.address1],
    ["address2", opts.address2],
    ["town", opts.town],
    ["region", opts.region],
    ["postcode", opts.postcode],
    ["country", opts.country],
    ["charge_sales_tax", opts.chargeSalesTax],
    // Without the client's VAT number a reverse-charge invoice is not a valid
    // one — FreeAgent prints it on the invoice, and the EC Sales List needs it.
    ["sales_tax_registration_number", opts.salesTaxRegistrationNumber],
    ["default_payment_terms_in_days", opts.defaultPaymentTermsInDays],
    ["status", opts.status],
  ];
  // `clearEmpty` steers the loop below; it is not a FreeAgent attribute.
  for (const [key, value] of map) {
    if (value === undefined) continue;
    // On create a blank is noise, so it is dropped. On update it means
    // "clear this" — see buildContactUpdateBody, which maps it to null.
    if (value === "") {
      if (!opts.clearEmpty) continue;
      contact[key] = null;
      continue;
    }
    contact[key] = value;
  }
  // Show the organisation on invoices unless the caller says otherwise.
  if (opts.contactNameOnInvoices !== undefined) {
    contact["contact_name_on_invoices"] = opts.contactNameOnInvoices;
  }
  return { contact };
}

export async function createContact(opts: ContactInput): Promise<Contact> {
  const data = await faPost<{ contact: Contact }>("/contacts", buildContactBody(opts));
  return { ...data.contact, id: extractId(data.contact) };
}

/**
 * Build the PUT /v2/contacts/:id body.
 *
 * Unlike create, an update needs no name: renaming is one of the things it is
 * for, and the existing name stands when none is given. Only named fields are
 * sent so a PUT cannot blank out a field the caller never mentioned.
 */
export function buildContactUpdateBody(opts: ContactInput): {
  contact: Record<string, unknown>;
} {
  const { contact } = buildContactBody({
    ...opts,
    clearEmpty: true,
    // Satisfy the create-time name rule without sending a name of our own.
    organisationName: opts.organisationName ?? "-",
  });
  if (!opts.organisationName) delete contact["organisation_name"];
  if (Object.keys(contact).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { contact };
}

export async function updateContact(
  contactId: string,
  opts: ContactInput
): Promise<Contact> {
  const id = assertNumericId(contactId, "contact");
  const data = await faPut<{ contact: Contact }>(
    `/contacts/${id}`,
    buildContactUpdateBody(opts)
  );
  return { ...data.contact, id: extractId(data.contact) };
}

export async function getContact(contactId: string): Promise<Contact> {
  const id = assertNumericId(contactId, "contact");
  const data = await faGet<{ contact: Contact }>(`/contacts/${id}`);
  return { ...data.contact, id: extractId(data.contact) };
}

export async function deleteContact(contactId: string): Promise<void> {
  await faDelete(`/contacts/${assertNumericId(contactId, "contact")}`);
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export type InvoiceView =
  | "all"
  | "recent_open_or_overdue"
  | "open"
  | "overdue"
  | "open_or_overdue"
  | "draft"
  | "paid";

export async function listInvoices(opts: {
  view?: InvoiceView;
  contactUrl?: string;
  projectUrl?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
} = {}): Promise<PagedResult<Invoice>> {
  const params: Record<string, unknown> = {};
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.contactUrl) params["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  const { items, mayHaveMore } = await faGetPaged<Invoice>(
    "/invoices",
    "invoices",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((i) => ({ ...i, id: extractId(i) })), mayHaveMore };
}

export async function getInvoice(invoiceId: string): Promise<Invoice> {
  const id = assertNumericId(invoiceId, "invoice");
  const data = await faGet<{ invoice: Invoice }>(`/invoices/${id}`);
  return { ...data.invoice, id: extractId(data.invoice) };
}

/**
 * Invoices add EC VAT MOSS to the four statuses a purchase can carry.
 */
export type InvoiceEcStatus = EcStatus | "EC VAT MOSS";

export interface InvoiceItemInput {
  description: string;
  itemType: string;
  price: string;
  quantity: string;
  salesTaxRate?: string;
  salesTaxStatus?: "TAXABLE" | "EXEMPT";
  categoryUrl?: string;
}

export interface InvoiceInput {
  contactUrl: string;
  datedOn: string;
  paymentTermsInDays: number;
  items: InvoiceItemInput[];
  reference?: string;
  currency?: string;
  projectUrl?: string;
  poReference?: string;
  comments?: string;
  discountPercent?: string;
  ecStatus?: InvoiceEcStatus;
  placeOfSupply?: string;
}

export function buildInvoiceBody(opts: InvoiceInput): { invoice: Record<string, unknown> } {
  if (!opts.items.length) {
    throw new Error("An invoice needs at least one line item.");
  }
  if (!Number.isInteger(opts.paymentTermsInDays) || opts.paymentTermsInDays < 0) {
    throw new Error(
      `Invalid payment terms "${opts.paymentTermsInDays}". Expected a whole number of days.`
    );
  }
  if (opts.ecStatus === "EC VAT MOSS" && !opts.placeOfSupply) {
    throw new Error(
      "EC VAT MOSS invoices need a placeOfSupply — the country whose VAT rate applies."
    );
  }

  const invoice: Record<string, unknown> = {
    contact: resolveContactUrl(opts.contactUrl),
    dated_on: opts.datedOn,
    payment_terms_in_days: opts.paymentTermsInDays,
    invoice_items: opts.items.map((item, index) => {
      // Reject a malformed price outright — "750.00x" must not become 750.
      toMinorUnits(item.price, `price on line ${index + 1}`);
      const line: Record<string, unknown> = {
        position: index + 1,
        description: item.description,
        item_type: item.itemType,
        price: item.price,
        quantity: item.quantity,
      };
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
      if (item.salesTaxStatus) line["sales_tax_status"] = item.salesTaxStatus;
      if (item.categoryUrl) line["category"] = resolveCategoryUrl(item.categoryUrl);
      return line;
    }),
  };

  if (opts.reference) invoice["reference"] = opts.reference;
  if (opts.currency) invoice["currency"] = opts.currency;
  if (opts.projectUrl) invoice["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.poReference) invoice["po_reference"] = opts.poReference;
  if (opts.comments) invoice["comments"] = opts.comments;
  if (opts.discountPercent) invoice["discount_percent"] = opts.discountPercent;
  // Left unset, FreeAgent raises the invoice as UK/Non-EC — so a sale to an
  // overseas client lands on the VAT return under the wrong box.
  if (opts.ecStatus) invoice["ec_status"] = opts.ecStatus;
  if (opts.placeOfSupply) invoice["place_of_supply"] = opts.placeOfSupply;

  return { invoice };
}

export async function createInvoice(opts: InvoiceInput): Promise<Invoice> {
  const data = await faPost<{ invoice: Invoice }>("/invoices", buildInvoiceBody(opts));
  return { ...data.invoice, id: extractId(data.invoice) };
}

export type InvoiceTransition =
  | "mark_as_draft"
  | "mark_as_sent"
  | "mark_as_scheduled"
  | "mark_as_cancelled";

/**
 * Move an invoice between states. These are status changes only — none of
 * them emails the client.
 */
export interface InvoiceUpdate {
  contactUrl?: string;
  datedOn?: string;
  paymentTermsInDays?: number;
  reference?: string;
  currency?: string;
  projectUrl?: string;
  poReference?: string;
  comments?: string;
  discountPercent?: string;
  ecStatus?: InvoiceEcStatus;
  placeOfSupply?: string;
  items?: Array<Partial<InvoiceItemInput> & { itemUrl?: string; destroy?: boolean }>;
}

/**
 * Build the PUT /v2/invoices/:id body.
 *
 * Line items are addressed by their own URL: one without a url is added, one
 * with a url is edited, and `destroy` removes it. Omitting invoice_items
 * entirely leaves the existing lines untouched — sending a fresh array without
 * urls would append duplicates rather than replace anything.
 */
export function buildInvoiceUpdateBody(opts: InvoiceUpdate): {
  invoice: Record<string, unknown>;
} {
  if (opts.ecStatus === "EC VAT MOSS" && !opts.placeOfSupply) {
    throw new Error(
      "EC VAT MOSS invoices need a placeOfSupply — the country whose VAT rate applies."
    );
  }
  if (
    opts.paymentTermsInDays !== undefined &&
    (!Number.isInteger(opts.paymentTermsInDays) || opts.paymentTermsInDays < 0)
  ) {
    throw new Error(
      `Invalid payment terms "${opts.paymentTermsInDays}". Expected a whole number of days.`
    );
  }

  const invoice: Record<string, unknown> = {};
  if (opts.contactUrl) invoice["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.datedOn) invoice["dated_on"] = opts.datedOn;
  if (opts.paymentTermsInDays !== undefined) {
    invoice["payment_terms_in_days"] = opts.paymentTermsInDays;
  }
  if (opts.reference) invoice["reference"] = opts.reference;
  if (opts.currency) invoice["currency"] = opts.currency;
  if (opts.projectUrl) invoice["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.poReference !== undefined) invoice["po_reference"] = opts.poReference;
  if (opts.comments !== undefined) invoice["comments"] = opts.comments;
  if (opts.discountPercent) invoice["discount_percent"] = opts.discountPercent;
  if (opts.ecStatus) invoice["ec_status"] = opts.ecStatus;
  if (opts.placeOfSupply) invoice["place_of_supply"] = opts.placeOfSupply;

  if (opts.items?.length) {
    invoice["invoice_items"] = opts.items.map((item, index) => {
      const line: Record<string, unknown> = {};
      if (item.itemUrl) line["url"] = resolveInvoiceItemUrl(item.itemUrl);
      if (item.destroy) {
        if (!item.itemUrl) {
          throw new Error(
            `Line ${index + 1} asks to be removed but has no itemUrl — read it from freeagent_get_invoice.`
          );
        }
        line["_destroy"] = 1;
        return line;
      }
      if (item.price !== undefined) {
        // Reject a malformed price outright — "750.00x" must not become 750.
        toMinorUnits(item.price, `price on line ${index + 1}`);
        line["price"] = item.price;
      }
      if (item.description !== undefined) line["description"] = item.description;
      if (item.itemType !== undefined) line["item_type"] = item.itemType;
      if (item.quantity !== undefined) line["quantity"] = item.quantity;
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
      if (item.salesTaxStatus) line["sales_tax_status"] = item.salesTaxStatus;
      if (item.categoryUrl) line["category"] = resolveCategoryUrl(item.categoryUrl);
      if (!item.itemUrl && (item.description === undefined || item.price === undefined)) {
        throw new Error(
          `Line ${index + 1} is new, so it needs both description and price.`
        );
      }
      return line;
    });
  }

  if (Object.keys(invoice).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { invoice };
}

export async function updateInvoice(
  invoiceId: string,
  opts: InvoiceUpdate
): Promise<Invoice> {
  const id = assertNumericId(invoiceId, "invoice");
  const data = await faPut<{ invoice: Invoice }>(
    `/invoices/${id}`,
    buildInvoiceUpdateBody(opts)
  );
  return { ...data.invoice, id: extractId(data.invoice) };
}

export async function transitionInvoice(
  invoiceId: string,
  transition: InvoiceTransition
): Promise<Invoice> {
  const id = assertNumericId(invoiceId, "invoice");
  const data = await faPut<{ invoice: Invoice }>(
    `/invoices/${id}/transitions/${transition}`,
    {}
  );
  return { ...data.invoice, id: extractId(data.invoice) };
}

export async function deleteInvoice(invoiceId: string): Promise<void> {
  await faDelete(`/invoices/${assertNumericId(invoiceId, "invoice")}`);
}

// ── Bills ────────────────────────────────────────────────────────────────────

export type BillView = "all" | "open" | "overdue" | "open_or_overdue" | "paid" | "recurring";

export async function listBills(opts: {
  view?: BillView;
  contactUrl?: string;
  projectUrl?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
} = {}): Promise<PagedResult<Bill>> {
  const params: Record<string, unknown> = {};
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.contactUrl) params["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  const { items, mayHaveMore } = await faGetPaged<Bill>(
    "/bills",
    "bills",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((b) => ({ ...b, id: extractId(b) })), mayHaveMore };
}

export interface BillItemInput {
  categoryUrl: string;
  totalValue: string;
  description?: string;
  salesTaxRate?: string;
  salesTaxStatus?: "TAXABLE" | "EXEMPT" | "OUT_OF_SCOPE";
  quantity?: string;
  unit?: string;
}

export interface BillInput {
  contactUrl: string;
  reference: string;
  datedOn: string;
  dueOn: string;
  items: BillItemInput[];
  currency?: string;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  comments?: string;
  attachment?: ExpenseAttachmentInput;
}

export function buildBillBody(opts: BillInput): { bill: Record<string, unknown> } {
  if (!opts.items.length) {
    throw new Error("A bill needs at least one line item.");
  }
  if (opts.items.length > 40) {
    throw new Error(`A bill accepts at most 40 line items (got ${opts.items.length}).`);
  }

  const bill: Record<string, unknown> = {
    contact: resolveContactUrl(opts.contactUrl),
    reference: opts.reference,
    dated_on: opts.datedOn,
    due_on: opts.dueOn,
    bill_items: opts.items.map((item) => {
      // A supplier bill is money owed, so each line must be positive. A credit
      // from a supplier is a different document, not a negative bill line.
      const minor = toMinorUnits(item.totalValue, "bill line value");
      if (minor <= 0) {
        throw new Error(
          `Invalid bill line value "${item.totalValue}". A bill line must be greater than zero.`
        );
      }
      const line: Record<string, unknown> = {
        category: resolveCategoryUrl(item.categoryUrl),
        total_value: item.totalValue,
      };
      if (item.description) line["description"] = item.description;
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
      if (item.salesTaxStatus) line["sales_tax_status"] = item.salesTaxStatus;
      if (item.quantity !== undefined) line["quantity"] = item.quantity;
      if (item.unit) line["unit"] = item.unit;
      return line;
    }),
  };

  if (opts.currency) bill["currency"] = opts.currency;
  if (opts.projectUrl) bill["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.rebillType) bill["rebill_type"] = opts.rebillType;
  if (opts.rebillFactor) bill["rebill_factor"] = opts.rebillFactor;
  // Same default as expenses: unset means UK/Non-EC, which is wrong for an
  // overseas supplier and for anything under the reverse charge.
  if (opts.ecStatus) bill["ec_status"] = opts.ecStatus;
  if (opts.comments) bill["comments"] = opts.comments;
  if (opts.attachment) {
    bill["attachment"] = {
      data: opts.attachment.fileBase64,
      file_name: opts.attachment.fileName,
      content_type: normalisePdfContentType(opts.attachment.contentType),
      description: opts.attachment.description ?? opts.attachment.fileName,
    };
  }

  return { bill };
}

export async function createBill(opts: BillInput): Promise<Bill> {
  const data = await faPost<{ bill: Bill }>("/bills", buildBillBody(opts));
  return { ...data.bill, id: extractId(data.bill) };
}

export async function getBill(billId: string): Promise<Bill> {
  const id = assertNumericId(billId, "bill");
  const data = await faGet<{ bill: Bill }>(`/bills/${id}`);
  return { ...data.bill, id: extractId(data.bill) };
}

export interface BillUpdate {
  contactUrl?: string;
  reference?: string;
  datedOn?: string;
  dueOn?: string;
  currency?: string;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
  rebillFactor?: string;
  ecStatus?: EcStatus;
  comments?: string;
  items?: Array<Partial<BillItemInput> & { itemUrl?: string; destroy?: boolean }>;
}

/**
 * Build the PUT /v2/bills/:id body.
 *
 * Line items follow FreeAgent's own convention: a line with no url is added,
 * one carrying its url is edited, and `destroy` removes it. Omit items
 * entirely to leave the existing lines alone.
 */
export function buildBillUpdateBody(opts: BillUpdate): { bill: Record<string, unknown> } {
  const bill: Record<string, unknown> = {};
  if (opts.contactUrl) bill["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.reference) bill["reference"] = opts.reference;
  if (opts.datedOn) bill["dated_on"] = opts.datedOn;
  if (opts.dueOn) bill["due_on"] = opts.dueOn;
  if (opts.currency) bill["currency"] = opts.currency;
  if (opts.projectUrl) bill["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.rebillType) bill["rebill_type"] = opts.rebillType;
  if (opts.rebillFactor) bill["rebill_factor"] = opts.rebillFactor;
  if (opts.ecStatus) bill["ec_status"] = opts.ecStatus;
  if (opts.comments !== undefined) bill["comments"] = opts.comments;

  if (opts.items?.length) {
    if (opts.items.length > 40) {
      throw new Error(`A bill accepts at most 40 line items (got ${opts.items.length}).`);
    }
    bill["bill_items"] = opts.items.map((item, index) => {
      const line: Record<string, unknown> = {};
      if (item.itemUrl) line["url"] = resolveBillItemUrl(item.itemUrl);
      if (item.destroy) {
        if (!item.itemUrl) {
          throw new Error(
            `Line ${index + 1} asks to be removed but has no itemUrl — read it from freeagent_get_bill.`
          );
        }
        line["_destroy"] = 1;
        return line;
      }
      if (item.categoryUrl) line["category"] = resolveCategoryUrl(item.categoryUrl);
      if (item.totalValue !== undefined) {
        const minor = toMinorUnits(item.totalValue, "bill line value");
        if (minor <= 0) {
          throw new Error(
            `Invalid bill line value "${item.totalValue}". A bill line must be greater than zero.`
          );
        }
        line["total_value"] = item.totalValue;
      }
      if (item.description !== undefined) line["description"] = item.description;
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
      if (item.salesTaxStatus) line["sales_tax_status"] = item.salesTaxStatus;
      if (item.quantity !== undefined) line["quantity"] = item.quantity;
      if (item.unit) line["unit"] = item.unit;
      if (!item.itemUrl && (!item.categoryUrl || item.totalValue === undefined)) {
        throw new Error(
          `Line ${index + 1} is new, so it needs both categoryUrl and totalValue.`
        );
      }
      return line;
    });
  }

  if (Object.keys(bill).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { bill };
}

export async function updateBill(billId: string, opts: BillUpdate): Promise<Bill> {
  const id = assertNumericId(billId, "bill");
  const data = await faPut<{ bill: Bill }>(`/bills/${id}`, buildBillUpdateBody(opts));
  return { ...data.bill, id: extractId(data.bill) };
}

export async function deleteBill(billId: string): Promise<void> {
  await faDelete(`/bills/${assertNumericId(billId, "bill")}`);
}

// ── Project tasks ────────────────────────────────────────────────────────────

export async function listTasks(opts: {
  projectUrl?: string;
  view?: "all" | "active" | "completed" | "hidden";
  limit?: number;
} = {}): Promise<PagedResult<Task>> {
  const params: Record<string, unknown> = {};
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  const { items, mayHaveMore } = await faGetPaged<Task>(
    "/tasks",
    "tasks",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((t) => ({ ...t, id: extractId(t) })), mayHaveMore };
}

export interface TaskInput {
  projectUrl: string;
  name: string;
  isBillable?: boolean;
  billingRate?: string;
  billingPeriod?: "hour" | "day";
  currency?: string;
  status?: "Active" | "Completed" | "Hidden";
}

export function buildTaskBody(opts: TaskInput): { task: Record<string, unknown> } {
  const task: Record<string, unknown> = {
    project: resolveProjectUrl(opts.projectUrl),
    name: opts.name,
  };
  if (opts.isBillable !== undefined) task["is_billable"] = opts.isBillable;
  if (opts.billingRate !== undefined) task["billing_rate"] = opts.billingRate;
  if (opts.billingPeriod) task["billing_period"] = opts.billingPeriod;
  if (opts.currency) task["currency"] = opts.currency;
  if (opts.status) task["status"] = opts.status;
  return { task };
}

export async function createTask(opts: TaskInput): Promise<Task> {
  const data = await faPost<{ task: Task }>("/tasks", buildTaskBody(opts));
  return { ...data.task, id: extractId(data.task) };
}

/**
 * Build the PUT /v2/tasks/:id body. The project cannot move, so it is not
 * accepted here — only the task's own attributes.
 */
export function buildTaskUpdateBody(
  opts: Omit<Partial<TaskInput>, "projectUrl">
): { task: Record<string, unknown> } {
  const task: Record<string, unknown> = {};
  if (opts.name) task["name"] = opts.name;
  if (opts.isBillable !== undefined) task["is_billable"] = opts.isBillable;
  if (opts.billingRate !== undefined) task["billing_rate"] = opts.billingRate;
  if (opts.billingPeriod) task["billing_period"] = opts.billingPeriod;
  if (opts.currency) task["currency"] = opts.currency;
  if (opts.status) task["status"] = opts.status;
  if (Object.keys(task).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { task };
}

export async function updateTask(
  taskId: string,
  opts: Omit<Partial<TaskInput>, "projectUrl">
): Promise<Task> {
  const id = assertNumericId(taskId, "task");
  const data = await faPut<{ task: Task }>(`/tasks/${id}`, buildTaskUpdateBody(opts));
  return { ...data.task, id: extractId(data.task) };
}

export async function deleteTask(taskId: string): Promise<void> {
  await faDelete(`/tasks/${assertNumericId(taskId, "task")}`);
}

// ── Timeslips ────────────────────────────────────────────────────────────────

export async function listTimeslips(opts: {
  fromDate: string;
  toDate: string;
  view?: "all" | "unbilled" | "running";
  userUrl?: string;
  projectUrl?: string;
  taskUrl?: string;
  limit?: number;
}): Promise<PagedResult<Timeslip>> {
  const params: Record<string, unknown> = {
    from_date: opts.fromDate,
    to_date: opts.toDate,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.userUrl) params["user"] = resolveUserUrl(opts.userUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.taskUrl) params["task"] = resolveTaskUrl(opts.taskUrl);

  const { items, mayHaveMore } = await faGetPaged<Timeslip>(
    "/timeslips",
    "timeslips",
    params,
    opts.limit ?? DEFAULT_LIST_LIMIT
  );
  return { items: items.map((t) => ({ ...t, id: extractId(t) })), mayHaveMore };
}

export function buildTimeslipBody(opts: {
  userUrl: string;
  projectUrl: string;
  taskUrl: string;
  datedOn: string;
  hours: string;
  comment?: string;
}): { timeslip: Record<string, unknown> } {
  if (!/^\d+(\.\d+)?$/.test(String(opts.hours).trim()) || Number(opts.hours) <= 0) {
    throw new Error(`Invalid hours "${opts.hours}". Expected a positive number like "1.5".`);
  }
  const timeslip: Record<string, unknown> = {
    user: resolveUserUrl(opts.userUrl),
    project: resolveProjectUrl(opts.projectUrl),
    task: resolveTaskUrl(opts.taskUrl),
    dated_on: opts.datedOn,
    hours: opts.hours,
  };
  if (opts.comment) timeslip["comment"] = opts.comment;
  return { timeslip };
}

export async function createTimeslip(opts: {
  projectUrl: string;
  taskUrl: string;
  datedOn: string;
  hours: string;
  comment?: string;
  userUrl?: string;
}): Promise<Timeslip> {
  const userUrl = opts.userUrl ?? (await getCurrentUserUrl());
  const body = buildTimeslipBody({ ...opts, userUrl });
  const data = await faPost<{ timeslip?: Timeslip; timeslips?: Timeslip[] }>(
    "/timeslips",
    body
  );
  // FreeAgent may answer with either the singular or the plural form.
  const timeslip = data.timeslip ?? data.timeslips?.[0];
  if (!timeslip) throw new Error("FreeAgent did not return the created timeslip.");
  return { ...timeslip, id: extractId(timeslip) };
}

export function buildTimeslipUpdateBody(opts: {
  taskUrl?: string;
  datedOn?: string;
  hours?: string;
  comment?: string;
}): { timeslip: Record<string, unknown> } {
  const timeslip: Record<string, unknown> = {};
  if (opts.taskUrl) timeslip["task"] = resolveTaskUrl(opts.taskUrl);
  if (opts.datedOn) timeslip["dated_on"] = opts.datedOn;
  if (opts.hours !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(String(opts.hours).trim()) || Number(opts.hours) <= 0) {
      throw new Error(`Invalid hours "${opts.hours}". Expected a positive number like "1.5".`);
    }
    timeslip["hours"] = opts.hours;
  }
  if (opts.comment !== undefined) timeslip["comment"] = opts.comment;
  if (Object.keys(timeslip).length === 0) {
    throw new Error("Nothing to update — supply at least one field to change.");
  }
  return { timeslip };
}

export async function updateTimeslip(
  timeslipId: string,
  opts: { taskUrl?: string; datedOn?: string; hours?: string; comment?: string }
): Promise<Timeslip> {
  const id = assertNumericId(timeslipId, "timeslip");
  const data = await faPut<{ timeslip?: Timeslip; timeslips?: Timeslip[] }>(
    `/timeslips/${id}`,
    buildTimeslipUpdateBody(opts)
  );
  const timeslip = data.timeslip ?? data.timeslips?.[0];
  if (!timeslip) throw new Error("FreeAgent did not return the updated timeslip.");
  return { ...timeslip, id: extractId(timeslip) };
}

export async function deleteTimeslip(timeslipId: string): Promise<void> {
  await faDelete(`/timeslips/${assertNumericId(timeslipId, "timeslip")}`);
}

// ── Reports ──────────────────────────────────────────────────────────────────

export async function getCompany(): Promise<Record<string, unknown>> {
  const data = await faGet<{ company: Record<string, unknown> }>("/company");
  return data.company;
}

export async function getProfitAndLoss(opts: {
  fromDate?: string;
  toDate?: string;
} = {}): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;
  const data = await faGet<{ profit_and_loss_summary: Record<string, unknown> }>(
    "/accounting/profit_and_loss/summary",
    params
  );
  return data.profit_and_loss_summary;
}

export async function getTrialBalance(opts: { asAt?: string } = {}): Promise<
  TrialBalanceEntry[]
> {
  const params: Record<string, unknown> = {};
  if (opts.asAt) params["as_at"] = opts.asAt;
  const data = await faGet<{ trial_balance_summary: TrialBalanceEntry[] }>(
    "/accounting/trial_balance/summary",
    params
  );
  return data.trial_balance_summary ?? [];
}

export async function getTaxTimeline(): Promise<TaxTimelineItem[]> {
  const data = await faGet<{ timeline_items: TaxTimelineItem[] }>(
    "/company/tax_timeline"
  );
  return data.timeline_items ?? [];
}

const AGEING_BUCKETS = [
  "not_yet_due",
  "1_30_days",
  "31_60_days",
  "61_90_days",
  "over_90_days",
  // A record FreeAgent returned with no usable due date. Kept separate so it
  // cannot masquerade as "not yet due" and quietly understate what is overdue.
  "unknown_due_date",
] as const;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a YYYY-MM-DD date to UTC ms, or null if it is absent/unusable. */
function parseDateOnly(value: string | undefined): number | null {
  if (!value || !DATE_ONLY_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse accepts "2026-02-31" and rolls it over; reject that.
  const iso = new Date(ms).toISOString().slice(0, 10);
  return iso === value ? ms : null;
}

export interface AgeingEntry {
  label: string;
  /** Optional in the type so a missing value reaches the guard and throws
   *  there, with the record named, rather than being defaulted at the callsite. */
  dueValue: string | undefined;
  dueOn?: string;
  reference?: string;
}

export interface AgeingReport {
  buckets: Record<string, { count: number; total: string }>;
  total: string;
  items: Array<AgeingEntry & { daysOverdue: number | null; bucket: string }>;
  /** Records FreeAgent returned without a usable due date. */
  unknownDueDateCount: number;
}

/**
 * Standard 30/60/90 ageing buckets, derived from open invoices or bills —
 * FreeAgent has no aged-debtors endpoint.
 *
 * Money is summed in integer pence, and a malformed value throws rather than
 * being coerced to zero: an ageing report that quietly drops a £12,000 invoice
 * because the API changed a field is worse than one that fails loudly.
 */
export function buildAgeingBuckets(
  entries: AgeingEntry[],
  today: string
): AgeingReport {
  const todayMs = parseDateOnly(today);
  if (todayMs === null) {
    throw new Error(`Invalid reporting date "${today}". Expected YYYY-MM-DD.`);
  }

  const buckets: Record<string, { count: number; totalMinor: number }> = {};
  for (const name of AGEING_BUCKETS) buckets[name] = { count: 0, totalMinor: 0 };

  let totalMinor = 0;
  let unknownDueDateCount = 0;

  const items = entries.map((entry) => {
    // Missing is refused, not zeroed: a £12,000 invoice dropping out of the
    // total because a field moved is exactly the failure this report exists
    // to avoid.
    const minor = requiredResponseMoneyToMinor(
      entry.dueValue,
      `outstanding value for "${entry.reference ?? entry.label}"`
    );
    totalMinor += minor;

    const dueMs = parseDateOnly(entry.dueOn);
    if (dueMs === null) {
      unknownDueDateCount++;
      buckets["unknown_due_date"]!.count += 1;
      buckets["unknown_due_date"]!.totalMinor += minor;
      return { ...entry, daysOverdue: null, bucket: "unknown_due_date" };
    }

    const daysOverdue = Math.floor((todayMs - dueMs) / 86_400_000);
    const bucket =
      daysOverdue <= 0 ? "not_yet_due"
      : daysOverdue <= 30 ? "1_30_days"
      : daysOverdue <= 60 ? "31_60_days"
      : daysOverdue <= 90 ? "61_90_days"
      : "over_90_days";
    buckets[bucket]!.count += 1;
    buckets[bucket]!.totalMinor += minor;
    return { ...entry, daysOverdue: Math.max(0, daysOverdue), bucket };
  });

  const formatted: Record<string, { count: number; total: string }> = {};
  for (const [name, b] of Object.entries(buckets)) {
    formatted[name] = { count: b.count, total: fromMinorUnits(b.totalMinor) };
  }

  return {
    buckets: formatted,
    total: fromMinorUnits(totalMinor),
    items,
    unknownDueDateCount,
  };
}

// ── Error helper ──────────────────────────────────────────────────────────────

/**
 * Pull human-readable validation messages out of a FreeAgent error body.
 *
 * FreeAgent uses several shapes:
 *   {"errors":[{"message":"user can't be blank"}, …]}   ← 422 validation
 *   {"errors":{"error":{"message":"…"}}}
 *   {"error":"invalid_grant","error_description":"…"}   ← OAuth
 *   {"errors":{"dated_on":["is not a valid date"]}}     ← field-keyed
 *
 * The previous implementation called String() on each entry, so an array of
 * objects rendered as "[object Object], [object Object]" and the real
 * messages never reached the caller.
 */
export function extractFreeAgentErrors(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown, field?: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) out.push(field ? `${field}: ${text}` : text);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, field);
      return;
    }

    const obj = value as Record<string, unknown>;
    // A {"message": "…"} node is the message itself — don't recurse further.
    if (typeof obj["message"] === "string") {
      walk(obj["message"], field);
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      // "errors"/"error" are envelopes, not field names; everything else
      // (e.g. "dated_on") is worth showing alongside its message.
      const nextField =
        key === "errors" || key === "error" || key === "error_description"
          ? field
          : key;
      walk(child, nextField);
    }
  };

  walk(data);
  return [...new Set(out)];
}

/** Render an error body as a single readable string, capped for safety. */
function formatErrorDetail(data: unknown): string {
  const messages = extractFreeAgentErrors(data);
  const detail = messages.join("; ");
  return detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
}

export function handleFAError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const detail = formatErrorDetail(error.response.data);
      switch (status) {
        case 401:
          return "Error: FreeAgent authentication failed. Check FREEAGENT_CLIENT_ID, CLIENT_SECRET, and REFRESH_TOKEN.";
        case 403:
          return `Error: Permission denied.${detail ? ` Detail: ${detail}` : ""}`;
        case 404:
          return "Error: Resource not found. Check the ID is correct.";
        case 422:
          return `Error: FreeAgent rejected the request. ${detail || "Check the data you supplied."}`;
        case 429:
          return "Error: FreeAgent rate limit exceeded. Wait a moment and try again.";
        default:
          return `Error: FreeAgent API returned status ${status}. ${detail}`;
      }
    }
    if (error.code === "ECONNABORTED") {
      return "Error: Request to FreeAgent timed out.";
    }
  }
  if (error instanceof Error && error.message.startsWith("Missing FreeAgent")) {
    return `Error: ${error.message}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
