// ── FreeAgent types ──────────────────────────────────────────────────────────

export interface FreeAgentToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export interface BankAccount {
  url: string;
  id: string;
  name: string;
  currency: string;
  balance: number;
  opening_balance: number;
  type: string;
  status: string;
}

export interface BankTransactionExplanation {
  url: string;
  id: string;
  bank_transaction: string;
  bank_account: string;
  category?: string;
  description?: string;
  dated_on?: string;
  gross_value?: string;
  sales_tax_rate?: string;
  sales_tax_value?: string;
  marked_for_review: boolean;
  type?: string;
  attachment?: string;
}

export interface BankTransaction {
  url: string;
  id: string;
  bank_account: string;
  dated_on: string;           // "YYYY-MM-DD"
  description: string;
  amount: string;             // e.g. "-22.80"
  is_manual: boolean;
  bank_transaction_explanations?: BankTransactionExplanation[];
}

/** @deprecated Use BankTransaction */
export interface BankAccountEntry {
  url: string;
  id: string;
  bank_account: string;
  dated_on: string;
  description: string;
  gross_value: string;
  status: string;
  attachment?: string;
  category?: string;
  transaction_type?: string;
}

export interface Attachment {
  url: string;
  id: string;
  content_type: string;
  file_name: string;
  file_size: number;
}

// ── Expense types ───────────────────────────────────────────────────────────

export interface Expense {
  url: string;
  id: string;
  user: string;
  category: string;
  dated_on: string;
  description: string;
  gross_value: string;
  native_amount?: string;
  sales_tax_rate?: string;
  sales_tax_value?: string;
  currency: string;
  manual_sales_tax_amount?: string;
  attachment?: string;
  project?: string;
  // Mileage-category expenses only
  mileage?: string;
  vehicle_type?: string;
  reclaim_mileage?: number;
  reclaim_mileage_rate?: string;
}

export interface ExpenseCategory {
  url: string;
  description: string;
  nominal_code: string;
  group?: string;
  /** FreeAgent's own grouping label, e.g. "Admin expenses (normally VATable)". */
  group_description?: string;
  /** Which of the four /v2/categories arrays this category came from. */
  category_type?: string;
  allowable_for_tax?: boolean;
  tax_reporting_name?: string;
  auto_sales_tax_rate?: string;
}

export interface Project {
  url: string;
  id: string;
  name: string;
  contact?: string;
  status: string;
  currency?: string;
  budget?: number;
  budget_units?: string;
  is_ir35?: boolean;
}

// ── Distance types ──────────────────────────────────────────────────────────

export interface DistanceResult {
  distanceMiles: number;
  origin: string;
  destination: string;
  provider: "openrouteservice" | "google_maps";
}
