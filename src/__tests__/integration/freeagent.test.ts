import { describe, it, expect, beforeEach, vi } from "vitest";
import axios, { AxiosError } from "axios";

vi.mock("axios");

// Import AFTER vi.mock so the module uses the mocked axios.
const freeagent = await import("../../services/freeagent.js");

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);
const mockedPut = vi.mocked(axios.put);

function setCreds(): void {
  process.env.FREEAGENT_CLIENT_ID = "test-client";
  process.env.FREEAGENT_CLIENT_SECRET = "test-secret";
  process.env.FREEAGENT_REFRESH_TOKEN = "test-refresh";
}

function mockTokenRefresh(accessToken = "test-access", expiresIn = 3600): void {
  mockedPost.mockResolvedValueOnce({
    data: { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setCreds();
  // @ts-expect-error — reset the module-level token cache between tests by
  // forcing a fresh module load. Vitest's resetModules is cleaner for this
  // but we'd lose the shared mock, so we instead re-import the cache reset
  // helper indirectly: listBankAccounts will trigger a token refresh each
  // test because we re-mock axios.post to return a fresh token.
});

// ── Token refresh ────────────────────────────────────────────────────────────

describe("FreeAgent token refresh", () => {
  it("fetches a new token on first call and reuses it for subsequent calls", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh("token-1");
    mockedGet.mockResolvedValue({ data: { bank_accounts: [] } } as never);

    await fa.listBankAccounts();
    await fa.listBankAccounts();

    // Token refresh (POST) should fire only once, even though GET fires twice.
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("throws a helpful error when credentials are missing", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    delete process.env.FREEAGENT_CLIENT_ID;

    await expect(fa.listBankAccounts()).rejects.toThrow(/Missing FreeAgent credentials/);
  });

  it("serialises concurrent refresh calls into a single token request", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");

    let resolveToken: (value: unknown) => void = () => {};
    mockedPost.mockImplementationOnce(
      () => new Promise((r) => { resolveToken = r; })
    );
    mockedGet.mockResolvedValue({ data: { bank_accounts: [] } } as never);

    // Fire two concurrent calls before the token resolves.
    const call1 = fa.listBankAccounts();
    const call2 = fa.listBankAccounts();

    resolveToken({
      data: { access_token: "shared-token", token_type: "Bearer", expires_in: 3600 },
    });

    await Promise.all([call1, call2]);

    // Only one POST to the token endpoint despite two parallel callers.
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});

// ── extractId behaviour (via listBankAccounts + listBankTransactions) ────────

describe("extractId (via public API)", () => {
  it("extracts numeric IDs from bank transaction URLs", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValueOnce({
      data: {
        bank_transactions: [
          {
            url: "https://api.freeagent.com/v2/bank_transactions/999",
            id: "legacy-id",
            bank_account: "/v2/bank_accounts/1",
            dated_on: "2026-04-12",
            description: "Test",
            amount: "22.80",
            is_manual: false,
            bank_transaction_explanations: [
              {
                url: "https://api.freeagent.com/v2/bank_transaction_explanations/555",
                id: "legacy-exp-id",
                bank_transaction: "/v2/bank_transactions/999",
                bank_account: "/v2/bank_accounts/1",
                marked_for_review: false,
              },
            ],
          },
        ],
      },
    } as never);

    const { items: result } = await fa.listBankTransactions({ bankAccountId: "1" });

    expect(result[0]!.id).toBe("999");
    expect(result[0]!.bank_transaction_explanations![0]!.id).toBe("555");
  });

  it("throws when FreeAgent returns a URL with no extractable ID", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValueOnce({
      data: {
        bank_transactions: [
          {
            url: "",
            id: "",
            bank_account: "",
            dated_on: "",
            description: "",
            amount: "",
            is_manual: false,
          },
        ],
      },
    } as never);

    await expect(fa.listBankTransactions({ bankAccountId: "1" })).rejects.toThrow(
      /Could not extract ID/
    );
  });
});

// ── Category path validation ─────────────────────────────────────────────────

describe("Category path validation", () => {
  it("rejects a malformed category path before calling FreeAgent", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();

    await expect(
      fa.updateExplanation({
        explanationId: "123",
        category: "../../../etc/passwd",
      })
    ).rejects.toThrow(/Invalid category/);

    // No PUT should have fired — we rejected before the network call.
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("accepts a valid category path", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedPut.mockResolvedValueOnce({
      data: {
        bank_transaction_explanation: {
          url: "/v2/bank_transaction_explanations/555",
          id: "old",
          bank_transaction: "/v2/bank_transactions/999",
          bank_account: "/v2/bank_accounts/1",
          marked_for_review: false,
        },
      },
    } as never);

    await expect(
      fa.updateExplanation({ explanationId: "555", category: "/v2/categories/285" })
    ).resolves.toBeDefined();
  });

  it("rejects a malformed categoryUrl in createExpense", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();

    await expect(
      fa.createExpense({
        categoryUrl: "not-a-valid-path",
        datedOn: "2026-04-12",
        description: "Test",
        grossValue: "22.80",
      })
    ).rejects.toThrow(/Invalid category/);
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("handleFAError", () => {
  it("returns a friendly message for 401", () => {
    const err = Object.assign(new AxiosError("Unauthorized"), {
      response: { status: 401, data: { errors: ["bad token"] } },
    });
    expect(freeagent.handleFAError(err)).toMatch(/authentication failed/);
  });

  it("surfaces validation detail for 422", () => {
    const err = Object.assign(new AxiosError("Unprocessable"), {
      response: { status: 422, data: { errors: ["Amount must be positive"] } },
    });
    expect(freeagent.handleFAError(err)).toMatch(/Amount must be positive/);
  });

  it("recognises rate-limit errors", () => {
    const err = Object.assign(new AxiosError("Too Many Requests"), {
      response: { status: 429, data: {} },
    });
    expect(freeagent.handleFAError(err)).toMatch(/rate limit/);
  });

  it("recognises timeout errors", () => {
    const err = Object.assign(new AxiosError("timeout"), { code: "ECONNABORTED" });
    expect(freeagent.handleFAError(err)).toMatch(/timed out/);
  });

  it("passes through missing-credentials errors", () => {
    const err = new Error(
      "Missing FreeAgent credentials. Set FREEAGENT_CLIENT_ID, FREEAGENT_CLIENT_SECRET, and FREEAGENT_REFRESH_TOKEN."
    );
    expect(freeagent.handleFAError(err)).toMatch(/Missing FreeAgent/);
  });

  it("stringifies unknown errors", () => {
    expect(freeagent.handleFAError(new Error("boom"))).toMatch(/boom/);
    expect(freeagent.handleFAError("plain string")).toMatch(/plain string/);
  });
});

// ── Mileage settings ─────────────────────────────────────────────────────────

/**
 * The rate FreeAgent will actually apply, read from the account rather than
 * guessed. The payload is date-ranged and its inner shape has changed before,
 * so the lookup has to degrade to null instead of filing a claim against a
 * number it half-understood.
 */
describe("getMileageRate", () => {
  async function withSettings(payload: unknown) {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValue({ data: payload } as never);
    return fa;
  }

  it("reads a banded car rate for the date", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [
          {
            from: "2011-04-06",
            to: null,
            value: {
              car: { initial_rate: 0.45, subsequent_rate: 0.25, threshold: 10000 },
              motorcycle: { initial_rate: 0.24 },
            },
          },
        ],
      },
    });

    expect(await fa.getMileageRate("2026-04-15", "Car")).toEqual({
      initialRatePence: 45,
      subsequentRatePence: 25,
      thresholdMiles: 10000,
    });
  });

  it("accepts a rate already quoted in pence", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [{ from: "2011-04-06", value: { car: { initial_rate: "45" } } }],
      },
    });
    expect(await fa.getMileageRate("2026-04-15", "Car")).toEqual({
      initialRatePence: 45,
      subsequentRatePence: undefined,
      thresholdMiles: undefined,
    });
  });

  it("picks the window covering the date, not the newest entry", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [
          { from: "2002-04-06", to: "2011-04-05", value: { car: { initial_rate: 0.4 } } },
          { from: "2011-04-06", to: null, value: { car: { initial_rate: 0.45 } } },
        ],
      },
    });
    const old = await fa.getMileageRate("2010-06-01", "Car");
    expect(old?.initialRatePence).toBe(40);
  });

  it("matches the vehicle key whatever its case or plural", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [{ from: "2011-04-06", value: { Motorcycles: 0.24 } }],
      },
    });
    expect((await fa.getMileageRate("2026-04-15", "Motorcycle"))?.initialRatePence).toBe(24);
  });

  it("returns null for a shape it does not recognise", async () => {
    const fa = await withSettings({ mileage_settings: { mileage_rates: "unexpected" } });
    expect(await fa.getMileageRate("2026-04-15", "Car")).toBeNull();
  });

  it("returns null when the vehicle has no published rate", async () => {
    const fa = await withSettings({
      mileage_settings: { mileage_rates: [{ from: "2011-04-06", value: { car: 0.45 } }] },
    });
    expect(await fa.getMileageRate("2026-04-15", "Bicycle")).toBeNull();
  });

  it("returns null rather than throwing when the request fails", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockRejectedValue(new Error("500") as never);
    expect(await fa.getMileageRate("2026-04-15", "Car")).toBeNull();
  });

  it("returns null when no published window covers the journey date", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [
          { from: "2025-04-06", to: "2026-04-05", value: { car: { initial_rate: 0.45 } } },
        ],
      },
    });

    // Falling back to the newest entry would file a historical journey at a
    // rate that did not exist yet; the caller's own rates are the better answer.
    expect(await fa.getMileageRate("2024-04-15", "Car")).toBeNull();
  });

  it("coalesces concurrent misses into one request", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [{ from: "2011-04-06", value: { car: { initial_rate: 0.45 } } }],
      },
    });

    const [a, b] = await Promise.all([
      fa.getMileageRate("2026-04-15", "Car"),
      fa.getMileageRate("2026-04-16", "Car"),
    ]);

    expect(a).toEqual(b);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache with a failed request", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockRejectedValueOnce(new Error("503") as never);
    expect(await fa.getMileageRate("2026-04-15", "Car")).toBeNull();

    mockedGet.mockResolvedValue({
      data: {
        mileage_settings: {
          mileage_rates: [{ from: "2011-04-06", value: { car: { initial_rate: 0.45 } } }],
        },
      },
    } as never);
    expect((await fa.getMileageRate("2026-04-15", "Car"))?.initialRatePence).toBe(45);
  });

  it("caches the settings across lookups", async () => {
    const fa = await withSettings({
      mileage_settings: {
        mileage_rates: [{ from: "2011-04-06", value: { car: { initial_rate: 0.45 } } }],
      },
    });
    await fa.getMileageRate("2026-04-15", "Car");
    await fa.getMileageRate("2026-05-15", "Car");
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });
});

// ── Update and delete paths ──────────────────────────────────────────────────

describe("update and delete requests", () => {
  async function freshModule() {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    return fa;
  }

  it("PUTs an expense update to the right path", async () => {
    const fa = await freshModule();
    mockedPut.mockResolvedValue({
      data: { expense: { url: "https://api.freeagent.com/v2/expenses/7", gross_value: "-22.80" } },
    } as never);

    await fa.updateExpense("7", { rebillType: "cost" });

    const [url, body] = mockedPut.mock.calls[0];
    expect(url).toContain("/v2/expenses/7");
    expect(body).toEqual({ expense: { rebill_type: "cost" } });
  });

  it("refuses a non-numeric id before spending a request", async () => {
    const fa = await freshModule();
    await expect(fa.updateExpense("7; DROP", { rebillType: "cost" })).rejects.toThrow(
      /Invalid expense ID/
    );
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("attaches to a bill through the bills collection", async () => {
    const fa = await freshModule();
    mockedPut.mockResolvedValue({
      data: { bill: { attachment: { url: "https://api.freeagent.com/v2/attachments/3" } } },
    } as never);

    await fa.uploadAttachment({
      entityId: "12",
      entityType: "bill",
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      fileBase64: "AAAA",
    });

    expect(mockedPut.mock.calls[0][0]).toContain("/v2/bills/12");
  });

  it("deletes an existing bill attachment before replacing it", async () => {
    const fa = await freshModule();
    mockedGet.mockResolvedValue({
      data: { bill: { attachment: { url: "https://api.freeagent.com/v2/attachments/9" } } },
    } as never);
    const mockedDelete = vi.mocked(axios.delete);
    mockedDelete.mockResolvedValue({ data: {} } as never);

    expect(await fa.deleteExistingAttachment("12", "bill")).toBe(true);
    expect(mockedDelete.mock.calls[0][0]).toContain("/v2/attachments/9");
  });
});

// ── Attachment replacement ───────────────────────────────────────────────────

/**
 * FreeAgent will not overwrite an attachment via PUT, so the old one must be
 * deleted first. That leaves a window where a failed upload strands the record
 * with no receipt at all — the one outcome the caller must not mistake for
 * "nothing happened".
 */
describe("replaceAttachment", () => {
  const FILE = {
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    fileBase64: "AAAA",
  };

  async function freshModule() {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    return fa;
  }

  it("reports that the previous attachment was replaced", async () => {
    const fa = await freshModule();
    mockedGet.mockResolvedValue({
      data: { expense: { attachment: { url: "https://api.freeagent.com/v2/attachments/9" } } },
    } as never);
    vi.mocked(axios.delete).mockResolvedValue({ data: {} } as never);
    mockedPut.mockResolvedValue({
      data: { expense: { attachment: { url: "https://api.freeagent.com/v2/attachments/10" } } },
    } as never);

    const result = await fa.replaceAttachment({
      entityId: "7",
      entityType: "expense",
      ...FILE,
    });
    expect(result.replaced).toBe(true);
  });

  it("says the record is now receiptless when the upload fails after a delete", async () => {
    const fa = await freshModule();
    mockedGet.mockResolvedValue({
      data: { expense: { attachment: { url: "https://api.freeagent.com/v2/attachments/9" } } },
    } as never);
    vi.mocked(axios.delete).mockResolvedValue({ data: {} } as never);
    mockedPut.mockRejectedValue(new Error("upload timed out") as never);

    await expect(
      fa.replaceAttachment({ entityId: "7", entityType: "expense", ...FILE })
    ).rejects.toThrow(/now has no attachment.*upload timed out/s);
  });

  it("surfaces the plain error when there was nothing to delete", async () => {
    const fa = await freshModule();
    mockedGet.mockResolvedValue({ data: { expense: {} } } as never);
    mockedPut.mockRejectedValue(new Error("upload timed out") as never);

    await expect(
      fa.replaceAttachment({ entityId: "7", entityType: "expense", ...FILE })
    ).rejects.toThrow(/^upload timed out$/);
  });
});

// ── Bank transaction rebilling ───────────────────────────────────────────────

/**
 * A bank transaction rebills exactly as an expense does. Until these fields
 * existed, a payment tagged to a project but with rebilling switched off could
 * not be corrected through the MCP at all — and it is invisible in a listing
 * too, so the client invoice just comes out short.
 */
describe("updateExplanation rebilling", () => {
  async function freshModule() {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedPut.mockResolvedValue({
      data: {
        bank_transaction_explanation: {
          url: "https://api.freeagent.com/v2/bank_transaction_explanations/5",
          marked_for_review: false,
        },
      },
    } as never);
    return fa;
  }

  it("sets the project and rebill type", async () => {
    const fa = await freshModule();
    await fa.updateExplanation({
      explanationId: "5",
      projectUrl: "/v2/projects/123",
      rebillType: "cost",
    });

    const [, body] = mockedPut.mock.calls[0];
    expect(body).toEqual({
      bank_transaction_explanation: {
        project: "https://api.freeagent.com/v2/projects/123",
        rebill_type: "cost",
      },
    });
  });

  it("carries a markup factor", async () => {
    const fa = await freshModule();
    await fa.updateExplanation({
      explanationId: "5",
      rebillType: "markup",
      rebillFactor: "15.0",
    });

    const [, body] = mockedPut.mock.calls[0] as [string, Record<string, Record<string, unknown>>];
    expect(body["bank_transaction_explanation"]).toMatchObject({
      rebill_type: "markup",
      rebill_factor: "15.0",
    });
  });

  it("turns rebilling off with an empty string", async () => {
    const fa = await freshModule();
    await fa.updateExplanation({ explanationId: "5", rebillType: "", projectUrl: "" });

    const [, body] = mockedPut.mock.calls[0] as [string, Record<string, Record<string, unknown>>];
    expect(body["bank_transaction_explanation"]).toEqual({
      project: null,
      rebill_type: null,
    });
  });

  it("leaves rebilling alone when not mentioned", async () => {
    const fa = await freshModule();
    await fa.updateExplanation({ explanationId: "5", description: "IONOS hosting" });

    const [, body] = mockedPut.mock.calls[0] as [string, Record<string, Record<string, unknown>>];
    expect(body["bank_transaction_explanation"]).toEqual({ description: "IONOS hosting" });
  });

  it("rejects a cross-type reference for the project", async () => {
    const fa = await freshModule();
    await expect(
      fa.updateExplanation({ explanationId: "5", projectUrl: "/v2/contacts/1" })
    ).rejects.toThrow();
    expect(mockedPut).not.toHaveBeenCalled();
  });
});

// ── Listing expenses ─────────────────────────────────────────────────────────

describe("listExpenses", () => {
  it("passes the documented filters through as query parameters", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValue({ data: { expenses: [] } } as never);

    await fa.listExpenses({
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
      projectUrl: "/v2/projects/123",
    });

    const [, config] = mockedGet.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(config.params).toMatchObject({
      from_date: "2026-04-01",
      to_date: "2026-04-30",
      project: "https://api.freeagent.com/v2/projects/123",
    });
  });

  it("omits the view parameter for 'all', which FreeAgent does not define", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValue({ data: { expenses: [] } } as never);

    await fa.listExpenses({ view: "all" });

    const [, config] = mockedGet.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(config.params).not.toHaveProperty("view");
  });

  it("extracts a numeric id for each expense", async () => {
    vi.resetModules();
    const fa = await import("../../services/freeagent.js");
    mockTokenRefresh();
    mockedGet.mockResolvedValue({
      data: {
        expenses: [
          { url: "https://api.freeagent.com/v2/expenses/77", gross_value: "-22.80" },
        ],
      },
    } as never);

    const { items } = await fa.listExpenses();
    expect(items[0]!.id).toBe("77");
  });
});
