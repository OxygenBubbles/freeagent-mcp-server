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
} from "../constants.js";
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

/** Replace secrets and bulky base64 blobs before anything reaches the log. */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 256 ? `<${value.length} chars omitted>` : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|client_id|^data$/i.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
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

function faPut<T>(path: string, body: unknown): Promise<T> {
  return faRequest("put", path, body);
}

function faPost<T>(path: string, body: unknown): Promise<T> {
  return faRequest("post", path, body);
}

async function faDelete(path: string): Promise<void> {
  const token = await getAccessToken();
  await axios.delete(`${FA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 30_000,
  });
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
export const resolveInvoiceUrl = makeUrlResolver("invoices", "invoice");
export const resolveBillUrl = makeUrlResolver("bills", "bill");

/**
 * Expense claims are recorded from the claimant's point of view: a negative
 * gross_value is money owed back to them, a positive value is a refund due
 * from them. The tools take a positive amount, so flip the sign here.
 */
export function toExpenseClaimValue(grossValue: string): string {
  const n = Number.parseFloat(grossValue);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid gross amount "${grossValue}". Expected a number like "22.80".`);
  }
  return n > 0 ? `-${Math.abs(n)}` : String(n);
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
}): Promise<BankTransaction[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params: Record<string, unknown> = {
    bank_account: `${FA_API_BASE}/bank_accounts/${opts.bankAccountId}`,
    per_page: limit,
    page: opts.page ?? 1,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  const data = await faGet<{ bank_transactions: BankTransaction[] }>(
    "/bank_transactions",
    params
  );

  return (data.bank_transactions ?? []).map((t) => ({
    ...t,
    id: extractId(t),
    bank_transaction_explanations: (t.bank_transaction_explanations ?? []).map((e) => ({
      ...e,
      id: extractId(e),
    })),
  }));
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
}): Promise<BankTransactionExplanation> {
  const body: Record<string, unknown> = {};
  if (opts.description !== undefined) body["description"] = opts.description;
  if (opts.category !== undefined) {
    body["category"] = resolveCategoryUrl(opts.category);
  }
  if (opts.markExplained) body["marked_for_review"] = false;

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
export async function uploadAttachment(opts: {
  entityId: string;
  entityType: "bank_transaction_explanation" | "expense";
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

  // Expenses: use PUT /expenses/:id with inline attachment
  const body = {
    expense: {
      attachment: {
        data: opts.fileBase64,
        file_name: opts.fileName,
        content_type: normalisePdfContentType(opts.contentType),
        description: opts.fileName,
      },
    },
  };
  const data = await faPut<{ expense: { attachment: Attachment } }>(
    `/expenses/${opts.entityId}`,
    body
  );
  return data.expense.attachment;
}

/**
 * Remove the attachment currently on a bank transaction explanation, if any.
 * FreeAgent rejects overwriting an attachment via PUT, so the old one must be
 * deleted before attaching a replacement. Returns true if one was removed.
 */
export async function deleteExistingAttachment(explanationId: string): Promise<boolean> {
  const data = await faGet<{
    bank_transaction_explanation: { attachment?: { url: string } };
  }>(`/bank_transaction_explanations/${explanationId}`);
  const att = data.bank_transaction_explanation?.attachment;
  if (!att?.url) return false;
  const attId = att.url.split("/").filter(Boolean).pop();
  await faDelete(`/attachments/${attId}`);
  return true;
}

/**
 * Download a file from a URL and return it base64-encoded, so a receipt PDF
 * (e.g. a Stripe "Download invoice" link) can be attached without the caller
 * ever handling the raw bytes. Follows redirects.
 */
export async function fetchUrlAsBase64(
  url: string
): Promise<{ base64: string; fileName?: string; contentType?: string }> {
  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
    maxRedirects: 5,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
  });
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
  if (cachedCategories) return cachedCategories;
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
  return cachedCategories;
}

/** Exported for tests — clears the module-level category cache. */
export function _resetCategoryCache(): void {
  cachedCategories = null;
}

// ── Users ────────────────────────────────────────────────────────────────────

let cachedUserUrl: string | null = null;

/**
 * The URL of the authenticated user. FreeAgent requires `user` on every
 * expense — omitting it is rejected with "user can't be blank".
 */
export async function getCurrentUserUrl(): Promise<string> {
  if (cachedUserUrl) return cachedUserUrl;
  const data = await faGet<{ user?: { url?: string } }>("/users/me");
  const url = data.user?.url;
  if (!url) {
    throw new Error("FreeAgent did not return a user URL from /users/me.");
  }
  cachedUserUrl = url;
  return url;
}

/** Exported for tests — clears the module-level user cache. */
export function _resetUserCache(): void {
  cachedUserUrl = null;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(view?: "active" | "completed" | "cancelled" | "all"): Promise<Project[]> {
  const params: Record<string, unknown> = {};
  if (view && view !== "all") params["view"] = view;
  const data = await faGet<{ projects: Project[] }>("/projects", params);
  return (data.projects ?? []).map((p) => ({ ...p, id: extractId(p) }));
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export interface ExpenseAttachmentInput {
  fileName: string;
  contentType: string;
  fileBase64: string;
  description?: string;
}

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
  projectUrl?: string;
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
  if (opts.projectUrl) expense["project"] = resolveProjectUrl(opts.projectUrl);
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
  projectUrl?: string;
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
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
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
  if (opts.projectUrl) expense["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.rebillType) expense["rebill_type"] = opts.rebillType;
  return { expense };
}

export async function createMileageExpense(opts: {
  categoryUrl: string;
  datedOn: string;
  description: string;
  miles: number;
  vehicleType: VehicleType;
  currency?: string;
  projectUrl?: string;
  rebillType?: "cost" | "markup" | "price";
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

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function listContacts(opts: {
  view?: "all" | "active" | "clients" | "suppliers" | "hidden";
  limit?: number;
  page?: number;
} = {}): Promise<Contact[]> {
  const params: Record<string, unknown> = {
    per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    page: opts.page ?? 1,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  const data = await faGet<{ contacts: Contact[] }>("/contacts", params);
  return (data.contacts ?? []).map((c) => ({ ...c, id: extractId(c) }));
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
  ];
  for (const [key, value] of map) {
    if (value !== undefined && value !== "") contact[key] = value;
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
  page?: number;
} = {}): Promise<Invoice[]> {
  const params: Record<string, unknown> = {
    per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    page: opts.page ?? 1,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.contactUrl) params["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  const data = await faGet<{ invoices: Invoice[] }>("/invoices", params);
  return (data.invoices ?? []).map((i) => ({ ...i, id: extractId(i) }));
}

export async function getInvoice(invoiceId: string): Promise<Invoice> {
  const data = await faGet<{ invoice: Invoice }>(`/invoices/${invoiceId}`);
  return { ...data.invoice, id: extractId(data.invoice) };
}

export interface InvoiceItemInput {
  description: string;
  itemType: string;
  price: string;
  quantity: string;
  salesTaxRate?: string;
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

  const invoice: Record<string, unknown> = {
    contact: resolveContactUrl(opts.contactUrl),
    dated_on: opts.datedOn,
    payment_terms_in_days: opts.paymentTermsInDays,
    invoice_items: opts.items.map((item, index) => {
      const line: Record<string, unknown> = {
        position: index + 1,
        description: item.description,
        item_type: item.itemType,
        price: item.price,
        quantity: item.quantity,
      };
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
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
export async function transitionInvoice(
  invoiceId: string,
  transition: InvoiceTransition
): Promise<Invoice> {
  const data = await faPut<{ invoice: Invoice }>(
    `/invoices/${invoiceId}/transitions/${transition}`,
    {}
  );
  return { ...data.invoice, id: extractId(data.invoice) };
}

export async function deleteInvoice(invoiceId: string): Promise<void> {
  await faDelete(`/invoices/${invoiceId}`);
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
  page?: number;
} = {}): Promise<Bill[]> {
  const params: Record<string, unknown> = {
    per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    page: opts.page ?? 1,
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.contactUrl) params["contact"] = resolveContactUrl(opts.contactUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.fromDate) params["from_date"] = opts.fromDate;
  if (opts.toDate) params["to_date"] = opts.toDate;

  const data = await faGet<{ bills: Bill[] }>("/bills", params);
  return (data.bills ?? []).map((b) => ({ ...b, id: extractId(b) }));
}

export interface BillItemInput {
  categoryUrl: string;
  totalValue: string;
  description?: string;
  salesTaxRate?: string;
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
      const line: Record<string, unknown> = {
        category: resolveCategoryUrl(item.categoryUrl),
        total_value: item.totalValue,
      };
      if (item.description) line["description"] = item.description;
      if (item.salesTaxRate !== undefined) line["sales_tax_rate"] = item.salesTaxRate;
      return line;
    }),
  };

  if (opts.currency) bill["currency"] = opts.currency;
  if (opts.projectUrl) bill["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.rebillType) bill["rebill_type"] = opts.rebillType;
  if (opts.rebillFactor) bill["rebill_factor"] = opts.rebillFactor;
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

export async function deleteBill(billId: string): Promise<void> {
  await faDelete(`/bills/${billId}`);
}

// ── Project tasks ────────────────────────────────────────────────────────────

export async function listTasks(opts: {
  projectUrl?: string;
  view?: "all" | "active" | "completed" | "hidden";
  limit?: number;
} = {}): Promise<Task[]> {
  const params: Record<string, unknown> = {
    per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  const data = await faGet<{ tasks: Task[] }>("/tasks", params);
  return (data.tasks ?? []).map((t) => ({ ...t, id: extractId(t) }));
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

// ── Timeslips ────────────────────────────────────────────────────────────────

export async function listTimeslips(opts: {
  fromDate: string;
  toDate: string;
  view?: "all" | "unbilled" | "running";
  userUrl?: string;
  projectUrl?: string;
  taskUrl?: string;
  limit?: number;
}): Promise<Timeslip[]> {
  const params: Record<string, unknown> = {
    from_date: opts.fromDate,
    to_date: opts.toDate,
    per_page: Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
  if (opts.view && opts.view !== "all") params["view"] = opts.view;
  if (opts.userUrl) params["user"] = resolveUserUrl(opts.userUrl);
  if (opts.projectUrl) params["project"] = resolveProjectUrl(opts.projectUrl);
  if (opts.taskUrl) params["task"] = resolveTaskUrl(opts.taskUrl);

  const data = await faGet<{ timeslips: Timeslip[] }>("/timeslips", params);
  return (data.timeslips ?? []).map((t) => ({ ...t, id: extractId(t) }));
}

export function buildTimeslipBody(opts: {
  userUrl: string;
  projectUrl: string;
  taskUrl: string;
  datedOn: string;
  hours: string;
  comment?: string;
}): { timeslip: Record<string, unknown> } {
  const hours = Number.parseFloat(opts.hours);
  if (!Number.isFinite(hours) || hours <= 0) {
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

export async function deleteTimeslip(timeslipId: string): Promise<void> {
  await faDelete(`/timeslips/${timeslipId}`);
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

/**
 * Standard 30/60/90 ageing buckets, computed from the open invoices or bills.
 * FreeAgent has no aged-debtors endpoint, so this derives them.
 */
export function buildAgeingBuckets(
  entries: Array<{ dueOn?: string; dueValue: string; label: string; reference?: string }>,
  today: string
): {
  buckets: Record<string, { count: number; total: string }>;
  total: string;
  items: Array<{ label: string; reference?: string; dueOn?: string; dueValue: string; daysOverdue: number; bucket: string }>;
} {
  const bucketNames = ["not_yet_due", "1_30_days", "31_60_days", "61_90_days", "over_90_days"];
  const buckets: Record<string, { count: number; total: number }> = {};
  for (const name of bucketNames) buckets[name] = { count: 0, total: 0 };

  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const items = entries.map((entry) => {
    const value = Number.parseFloat(entry.dueValue) || 0;
    const dueMs = entry.dueOn ? Date.parse(`${entry.dueOn}T00:00:00Z`) : NaN;
    const daysOverdue = Number.isFinite(dueMs)
      ? Math.floor((todayMs - dueMs) / 86_400_000)
      : 0;
    const bucket =
      daysOverdue <= 0 ? "not_yet_due"
      : daysOverdue <= 30 ? "1_30_days"
      : daysOverdue <= 60 ? "31_60_days"
      : daysOverdue <= 90 ? "61_90_days"
      : "over_90_days";
    buckets[bucket]!.count += 1;
    buckets[bucket]!.total += value;
    return { ...entry, daysOverdue: Math.max(0, daysOverdue), bucket };
  });

  const total = items.reduce((sum, i) => sum + (Number.parseFloat(i.dueValue) || 0), 0);
  const rounded: Record<string, { count: number; total: string }> = {};
  for (const [name, b] of Object.entries(buckets)) {
    rounded[name] = { count: b.count, total: b.total.toFixed(2) };
  }
  return { buckets: rounded, total: total.toFixed(2), items };
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
