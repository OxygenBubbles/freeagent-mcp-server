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

// ── Contacts ────────────────────────────────────────────────────────────────

export interface Contact {
  url: string;
  id: string;
  organisation_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  status: string;
  account_balance?: string;
  active_projects_count?: number;
  town?: string;
  postcode?: string;
  country?: string;
}

// ── Invoices ────────────────────────────────────────────────────────────────

export interface InvoiceItem {
  url?: string;
  position?: number;
  description: string;
  item_type: string;
  price: string;
  quantity: string;
  sales_tax_rate?: string;
  category?: string;
}

export interface Invoice {
  url: string;
  id: string;
  contact: string;
  contact_name?: string;
  reference?: string;
  status: string;
  long_status?: string;
  dated_on: string;
  due_on?: string;
  paid_on?: string;
  currency: string;
  net_value: string;
  sales_tax_value?: string;
  total_value: string;
  paid_value?: string;
  due_value?: string;
  payment_terms_in_days?: number;
  project?: string;
  po_reference?: string;
  comments?: string;
  invoice_items?: InvoiceItem[];
}

// ── Bills ───────────────────────────────────────────────────────────────────

export interface BillItem {
  url?: string;
  category: string;
  description?: string;
  total_value: string;
  sales_tax_rate?: string;
}

export interface Bill {
  url: string;
  id: string;
  contact: string;
  reference?: string;
  dated_on: string;
  due_on?: string;
  paid_on?: string;
  currency?: string;
  total_value: string;
  paid_value?: string;
  due_value?: string;
  status?: string;
  project?: string;
  bill_items?: BillItem[];
}

// ── Tasks and timeslips ─────────────────────────────────────────────────────

export interface Task {
  url: string;
  id: string;
  project: string;
  name: string;
  is_billable?: boolean;
  billing_rate?: string;
  billing_period?: string;
  currency?: string;
  status?: string;
}

export interface Timeslip {
  url: string;
  id: string;
  user: string;
  project: string;
  task: string;
  dated_on: string;
  hours: string;
  comment?: string;
  billed_on_invoice?: string;
}

// ── Reports ─────────────────────────────────────────────────────────────────

export interface TrialBalanceEntry {
  category: string;
  nominal_code: string;
  display_nominal_code?: string;
  name: string;
  total: string;
}

export interface TaxTimelineItem {
  description: string;
  nature: string;
  dated_on: string;
  amount_due?: string;
  is_personal?: boolean;
  status?: string;
}

// ── Distance types ──────────────────────────────────────────────────────────

export interface DistanceResult {
  distanceMiles: number;
  origin: string;
  destination: string;
  provider: "openrouteservice" | "google_maps";
}
