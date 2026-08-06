/**
 * End-to-end scenarios using the synthetic FreeAgent fixtures.
 *
 * These tests exercise the service layer against a routing-based axios mock
 * backed by realistic synthetic data. They complement the unit tests by
 * verifying that the API client assembles requests correctly and parses
 * responses as expected across the full tool set.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import axios from "axios";
import { defaultFixture } from "../fixtures/freeagent-data.js";
import { mockFreeAgentAxios, type MockedFreeAgentAxios } from "../fixtures/mock-axios.js";

vi.mock("axios");

let mock: MockedFreeAgentAxios;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.FREEAGENT_CLIENT_ID = "test-id";
  process.env.FREEAGENT_CLIENT_SECRET = "test-secret";
  process.env.FREEAGENT_REFRESH_TOKEN = "test-refresh";
  mock = mockFreeAgentAxios(defaultFixture);
});

describe("Scenario: list bank accounts", () => {
  it("returns all accounts with extracted numeric IDs", async () => {
    const { listBankAccounts } = await import("../../services/freeagent.js");
    const accounts = await listBankAccounts();

    expect(accounts).toHaveLength(3);
    expect(accounts[0]!.id).toBe("1000001");
    expect(accounts[0]!.name).toBe("Starling Business Current");
    expect(accounts[2]!.type).toBe("CreditCardAccount");
  });
});

describe("Scenario: list transactions filters by view", () => {
  it("returns only unexplained when view=unexplained", async () => {
    const { listBankTransactions } = await import("../../services/freeagent.js");
    const { items: txs } = await listBankTransactions({ bankAccountId: "1000001", view: "unexplained" });

    expect(txs.length).toBeGreaterThan(0);
    expect(txs.every((t) => !t.bank_transaction_explanations?.[0]?.category)).toBe(true);
  });

  it("returns only marked-for-review when view=marked_for_review", async () => {
    const { listBankTransactions } = await import("../../services/freeagent.js");
    const { items: txs } = await listBankTransactions({
      bankAccountId: "1000001",
      view: "marked_for_review",
    });

    expect(txs.length).toBeGreaterThan(0);
    expect(
      txs.every((t) => t.bank_transaction_explanations?.[0]?.marked_for_review === true)
    ).toBe(true);
  });

  it("extracts numeric IDs from both transactions and their explanations", async () => {
    const { listBankTransactions } = await import("../../services/freeagent.js");
    const { items: txs } = await listBankTransactions({ bankAccountId: "1000001" });

    for (const t of txs) {
      expect(t.id).toMatch(/^\d+$/);
      for (const exp of t.bank_transaction_explanations ?? []) {
        expect(exp.id).toMatch(/^\d+$/);
      }
    }
  });
});

describe("Scenario: approve a marked-for-review transaction", () => {
  it("clears marked_for_review and records the update", async () => {
    const { updateExplanation } = await import("../../services/freeagent.js");
    const result = await updateExplanation({
      explanationId: "9000002",
      markExplained: true,
    });

    expect(result.id).toBe("9000002");
    expect(result.marked_for_review).toBe(false);
    expect(mock.state.explanationUpdates).toHaveLength(1);

    const updateBody = mock.state.explanationUpdates[0]!.body as {
      bank_transaction_explanation: { marked_for_review?: boolean };
    };
    expect(updateBody.bank_transaction_explanation.marked_for_review).toBe(false);
  });

  it("refuses a path-traversal category", async () => {
    const { updateExplanation } = await import("../../services/freeagent.js");
    await expect(
      updateExplanation({
        explanationId: "9000001",
        category: "../../../evil",
      })
    ).rejects.toThrow(/Invalid category/);

    expect(mock.state.explanationUpdates).toHaveLength(0);
  });
});

describe("Scenario: create expense and link to bank transaction", () => {
  it("creates an expense, then links it via a new explanation", async () => {
    const { createExpense, linkExpenseToEntry } = await import(
      "../../services/freeagent.js"
    );

    const expense = await createExpense({
      categoryUrl: "/v2/categories/270",
      datedOn: "2026-04-08",
      description: "Anthropic — API credits",
      grossValue: "20.00",
    });

    expect(expense.id).toMatch(/^\d+$/);
    expect(mock.state.createdExpenses).toHaveLength(1);

    await linkExpenseToEntry({
      entryId: "8000002",
      expenseUrl: expense.url,
    });

    expect(mock.state.linkedExpenses).toHaveLength(1);
    const linkBody = mock.state.linkedExpenses[0]!.body as {
      bank_transaction_explanation: { expense?: string; type?: string };
    };
    expect(linkBody.bank_transaction_explanation.type).toBe("Expense");
    expect(linkBody.bank_transaction_explanation.expense).toBe(expense.url);
  });
});

describe("Scenario: list categories (cached)", () => {
  it("returns the synthetic chart of accounts", async () => {
    const { listCategories } = await import("../../services/freeagent.js");
    const categories = await listCategories();

    expect(categories.length).toBeGreaterThan(0);
    expect(categories.map((c) => c.nominal_code)).toContain("285");
    expect(categories.map((c) => c.nominal_code)).toContain("249");
    // All four category groups must be flattened, not just admin expenses.
    expect(categories.map((c) => c.nominal_code)).toContain("150");
    expect(categories.map((c) => c.nominal_code)).toContain("001");
  });
});
