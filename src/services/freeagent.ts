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
} from "../types.js";

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
  const response = await axios.get<T>(`${FA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params,
    timeout: 30_000,
  });
  return response.data;
}

async function faRequest<T>(
  method: "put" | "post",
  path: string,
  body: unknown
): Promise<T> {
  const token = await getAccessToken();
  const response = await axios[method]<T>(`${FA_API_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 30_000,
  });
  return response.data;
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

const CATEGORY_PATH_RE = /^\/v2\/categories\/\d+$/;

function validateCategoryPath(path: string): void {
  if (!CATEGORY_PATH_RE.test(path)) {
    throw new Error(
      `Invalid category path "${path}". Expected format: /v2/categories/<id>`
    );
  }
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
    validateCategoryPath(opts.category);
    body["category"] = `${FA_API_BASE}${opts.category}`;
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
        content_type: opts.contentType === "application/pdf" ? "application/x-pdf" : opts.contentType,
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
        content_type: opts.contentType === "application/pdf" ? "application/x-pdf" : opts.contentType,
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

export async function listCategories(): Promise<ExpenseCategory[]> {
  if (cachedCategories) return cachedCategories;
  const data = await faGet<{ categories: ExpenseCategory[] }>("/categories");
  cachedCategories = data.categories ?? [];
  return cachedCategories;
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export async function createExpense(opts: {
  categoryUrl: string;
  datedOn: string;
  description: string;
  grossValue: string;
  currency?: string;
  salesTaxRate?: string;
  manualSalesTaxAmount?: string;
}): Promise<Expense> {
  validateCategoryPath(opts.categoryUrl);

  const body: Record<string, unknown> = {
    expense: {
      category: `${FA_API_BASE}${opts.categoryUrl}`,
      dated_on: opts.datedOn,
      description: opts.description,
      gross_value: opts.grossValue,
      currency: opts.currency ?? "GBP",
      ...(opts.salesTaxRate && { sales_tax_rate: opts.salesTaxRate }),
      ...(opts.manualSalesTaxAmount && {
        manual_sales_tax_amount: opts.manualSalesTaxAmount,
      }),
    },
  };

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

// ── Error helper ──────────────────────────────────────────────────────────────

export function handleFAError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const rawErrors = (error.response.data as { errors?: unknown })?.errors;
      const detail = Array.isArray(rawErrors)
        ? rawErrors.map(String).join(", ")
        : rawErrors != null
          ? String(rawErrors)
          : "";
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
