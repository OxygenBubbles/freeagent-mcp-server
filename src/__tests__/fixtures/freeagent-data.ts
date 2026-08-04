/**
 * Synthetic FreeAgent API response data for tests.
 *
 * Shapes mirror the real FreeAgent v2 API. All IDs, names, and amounts are
 * fabricated — no data here corresponds to a real account.
 *
 * Test files can import `defaultFixture` for a realistic baseline, or build
 * customised responses with the factory helpers (makeBankAccount, etc.).
 */

import type {
  BankAccount,
  BankTransaction,
  BankTransactionExplanation,
  ExpenseCategory,
  Expense,
  FreeAgentToken,
} from "../../types.js";

const API = "https://api.freeagent.com/v2";

// ── Factories ────────────────────────────────────────────────────────────────

export function makeToken(overrides: Partial<FreeAgentToken> = {}): FreeAgentToken {
  return {
    access_token: "synthetic-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    ...overrides,
  };
}

export function makeBankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  const id = overrides.id ?? "1000001";
  return {
    url: `${API}/bank_accounts/${id}`,
    id,
    name: "Starling Business Current",
    currency: "GBP",
    balance: 4250.55,
    opening_balance: 0,
    type: "StandardBankAccount",
    status: "Active",
    ...overrides,
  };
}

export function makeExplanation(
  overrides: Partial<BankTransactionExplanation> = {}
): BankTransactionExplanation {
  const id = overrides.id ?? "9000001";
  return {
    url: `${API}/bank_transaction_explanations/${id}`,
    id,
    bank_transaction: `${API}/bank_transactions/8000001`,
    bank_account: `${API}/bank_accounts/1000001`,
    marked_for_review: false,
    ...overrides,
  };
}

export function makeBankTransaction(
  overrides: Partial<BankTransaction> = {}
): BankTransaction {
  const id = overrides.id ?? "8000001";
  return {
    url: `${API}/bank_transactions/${id}`,
    id,
    bank_account: `${API}/bank_accounts/1000001`,
    dated_on: "2026-04-10",
    description: "SYNTHETIC VENDOR LTD",
    amount: "-22.80",
    is_manual: false,
    bank_transaction_explanations: [],
    ...overrides,
  };
}

export function makeCategory(overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  const nominal = overrides.nominal_code ?? "269";
  return {
    url: `${API}/categories/${nominal}`,
    description: "Computer Software",
    nominal_code: nominal,
    group_description: "Admin expenses (normally VATable)",
    allowable_for_tax: true,
    ...overrides,
  };
}

export function makeExpense(overrides: Partial<Expense> = {}): Expense {
  const id = overrides.id ?? "7000001";
  return {
    url: `${API}/expenses/${id}`,
    id,
    user: `${API}/users/1`,
    category: `${API}/categories/285`,
    dated_on: "2026-04-10",
    description: "Test expense",
    gross_value: "22.80",
    currency: "GBP",
    ...overrides,
  };
}

// ── Default fixture — a realistic baseline for most scenarios ────────────────

export const defaultFixture = {
  token: makeToken(),

  bankAccounts: [
    makeBankAccount({
      id: "1000001",
      name: "Starling Business Current",
      balance: 4250.55,
    }),
    makeBankAccount({
      id: "1000002",
      name: "Starling Business Savings",
      balance: 12_000.0,
      type: "SavingsAccount",
    }),
    makeBankAccount({
      id: "1000003",
      name: "Capital on Tap Credit Card",
      balance: -340.0,
      type: "CreditCardAccount",
    }),
  ],

  // A mix of states: unexplained, explained, marked_for_review.
  bankTransactions: [
    // Unexplained — IONOS hosting, £22.80
    makeBankTransaction({
      id: "8000001",
      dated_on: "2026-04-10",
      description: "IONOS CLOUD DEBIT",
      amount: "-22.80",
      bank_transaction_explanations: [
        makeExplanation({
          id: "9000001",
          bank_transaction: `${API}/bank_transactions/8000001`,
          marked_for_review: false,
          // no category yet → counts as unexplained
        }),
      ],
    }),
    // Marked for review — auto-categorised Anthropic charge
    makeBankTransaction({
      id: "8000002",
      dated_on: "2026-04-08",
      description: "ANTHROPIC SERVICES",
      amount: "-20.00",
      bank_transaction_explanations: [
        makeExplanation({
          id: "9000002",
          bank_transaction: `${API}/bank_transactions/8000002`,
          category: `${API}/categories/270`,
          marked_for_review: true,
          description: "Anthropic — API credits",
        }),
      ],
    }),
    // Fully explained — GitHub subscription
    makeBankTransaction({
      id: "8000003",
      dated_on: "2026-04-05",
      description: "GITHUB INC",
      amount: "-8.00",
      bank_transaction_explanations: [
        makeExplanation({
          id: "9000003",
          bank_transaction: `${API}/bank_transactions/8000003`,
          category: `${API}/categories/270`,
          marked_for_review: false,
          description: "GitHub — monthly subscription",
        }),
      ],
    }),
  ],

  user: {
    url: `${API}/users/2000001`,
    first_name: "Test",
    last_name: "User",
    email: "user@example.com",
  },

  projects: [
    {
      url: `${API}/projects/6000001`,
      name: "Synthetic Client Engagement",
      status: "Active",
      currency: "GBP",
      contact: `${API}/contacts/5000001`,
    },
    {
      url: `${API}/projects/6000002`,
      name: "Internal R&D",
      status: "Active",
      currency: "GBP",
    },
  ],

  // GET /v2/categories returns four parallel arrays, NOT a flat list.
  categories: {
    admin_expenses_categories: [
      makeCategory({ nominal_code: "269", description: "Computer Software" }),
      makeCategory({ nominal_code: "268", description: "Web Hosting" }),
      makeCategory({ nominal_code: "249", description: "Mileage" }),
      makeCategory({ nominal_code: "285", description: "Accommodation and Meals" }),
      makeCategory({
        nominal_code: "365",
        description: "Travel",
        group_description: "Admin expenses (normally Zero-VAT)",
      }),
    ],
    cost_of_sales_categories: [
      makeCategory({
        nominal_code: "150",
        description: "Subcontractor Costs",
        group_description: "Cost of sales",
      }),
    ],
    income_categories: [
      makeCategory({
        nominal_code: "001",
        description: "Sales",
        group_description: "Income",
      }),
    ],
    general_categories: [
      makeCategory({
        nominal_code: "750",
        description: "Bank Account",
        group_description: "Current assets",
      }),
    ],
  },
};
