/**
 * Routing-based axios mock for FreeAgent tests.
 *
 * Registers `get` / `post` / `put` handlers against URL patterns and dispatches
 * incoming calls to the matching handler. Tests stay declarative — you describe
 * the world, not the call order.
 *
 * Example:
 *
 *   import { defaultFixture } from "../fixtures/freeagent-data.js";
 *   import { mockFreeAgentAxios } from "../fixtures/mock-axios.js";
 *
 *   mockFreeAgentAxios(defaultFixture);
 *   const accounts = await listBankAccounts();
 */

import { vi } from "vitest";
import axios from "axios";
import type { defaultFixture } from "./freeagent-data.js";

type Fixture = typeof defaultFixture;

interface MockState {
  createdExpenses: Array<{ id: string; body: unknown }>;
  explanationUpdates: Array<{ id: string; body: unknown }>;
  linkedExpenses: Array<{ body: unknown }>;
}

export interface MockedFreeAgentAxios {
  state: MockState;
  reset(): void;
}

export function mockFreeAgentAxios(fixture: Fixture): MockedFreeAgentAxios {
  const state: MockState = {
    createdExpenses: [],
    explanationUpdates: [],
    linkedExpenses: [],
  };

  const mockedGet = vi.mocked(axios.get);
  const mockedPost = vi.mocked(axios.post);
  const mockedPut = vi.mocked(axios.put);

  // ── GET ────────────────────────────────────────────────────────────────────
  mockedGet.mockImplementation(async (url: string, config?: unknown) => {
    const { pathname, params } = dissect(url, config);

    if (pathname.endsWith("/bank_accounts")) {
      return { data: { bank_accounts: fixture.bankAccounts } } as never;
    }

    if (pathname.endsWith("/bank_transactions")) {
      const view = params["view"] as string | undefined;
      const txs = fixture.bankTransactions.filter((t) => {
        if (!view) return true;
        const exp = t.bank_transaction_explanations?.[0];
        if (view === "unexplained") return !exp?.category;
        if (view === "explained") return !!exp?.category && !exp?.marked_for_review;
        if (view === "marked_for_review") return !!exp?.marked_for_review;
        return true;
      });
      return { data: { bank_transactions: txs } } as never;
    }

    // Real shape: four parallel arrays, not a flat "categories" list.
    if (pathname.endsWith("/categories")) {
      return { data: fixture.categories } as never;
    }

    if (pathname.endsWith("/users/me")) {
      return { data: { user: fixture.user } } as never;
    }

    if (pathname.endsWith("/projects")) {
      return { data: { projects: fixture.projects } } as never;
    }

    throw new Error(`mockFreeAgentAxios: unmapped GET ${pathname}`);
  });

  // ── POST ───────────────────────────────────────────────────────────────────
  mockedPost.mockImplementation(async (url: string, body?: unknown) => {
    if (url.endsWith("/token_endpoint")) {
      return { data: fixture.token } as never;
    }

    if (url.endsWith("/expenses")) {
      const id = `${7_000_000 + state.createdExpenses.length + 1}`;
      state.createdExpenses.push({ id, body });
      const { makeExpense } = await import("./freeagent-data.js");
      return {
        data: {
          expense: makeExpense({
            id,
            description: extractFromExpenseBody(body, "description", "Test"),
            gross_value:  extractFromExpenseBody(body, "gross_value", "0.00"),
            currency:     extractFromExpenseBody(body, "currency", "GBP"),
          }),
        },
      } as never;
    }

    if (url.endsWith("/bank_transaction_explanations")) {
      state.linkedExpenses.push({ body });
      const { makeExplanation } = await import("./freeagent-data.js");
      return {
        data: {
          bank_transaction_explanation: makeExplanation({
            id: `${9_900_000 + state.linkedExpenses.length}`,
          }),
        },
      } as never;
    }

    throw new Error(`mockFreeAgentAxios: unmapped POST ${url}`);
  });

  // ── PUT ────────────────────────────────────────────────────────────────────
  mockedPut.mockImplementation(async (url: string, body?: unknown) => {
    const explanationMatch = url.match(/\/bank_transaction_explanations\/(\d+)$/);
    if (explanationMatch) {
      const id = explanationMatch[1]!;
      state.explanationUpdates.push({ id, body });
      const { makeExplanation } = await import("./freeagent-data.js");
      return {
        data: {
          bank_transaction_explanation: makeExplanation({
            id,
            marked_for_review: false,
            attachment: `${"https://api.freeagent.com/v2"}/attachments/synthetic`,
          }),
        },
      } as never;
    }

    const expenseMatch = url.match(/\/expenses\/(\d+)$/);
    if (expenseMatch) {
      const id = expenseMatch[1]!;
      const { makeExpense } = await import("./freeagent-data.js");
      return {
        data: {
          expense: {
            ...makeExpense({ id }),
            attachment: {
              url: "https://api.freeagent.com/v2/attachments/att-1",
              id: "att-1",
              content_type: "application/pdf",
              file_name: "receipt.pdf",
              file_size: 12_345,
            },
          },
        },
      } as never;
    }

    throw new Error(`mockFreeAgentAxios: unmapped PUT ${url}`);
  });

  return {
    state,
    reset: () => {
      state.createdExpenses.length = 0;
      state.explanationUpdates.length = 0;
      state.linkedExpenses.length = 0;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dissect(
  url: string,
  config?: unknown
): { pathname: string; params: Record<string, unknown> } {
  const u = new URL(url);
  const cfg = (config ?? {}) as { params?: Record<string, unknown> };
  return { pathname: u.pathname, params: cfg.params ?? {} };
}

function extractFromExpenseBody(body: unknown, key: string, fallback: string): string {
  const expense = (body as { expense?: Record<string, unknown> } | undefined)?.expense;
  const val = expense?.[key];
  return typeof val === "string" ? val : fallback;
}
