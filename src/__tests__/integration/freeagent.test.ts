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
