import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProfitAndLoss,
  getTrialBalance,
  getTaxTimeline,
  getCompany,
  listInvoices,
  listBills,
  buildAgeingBuckets,
} from "../services/freeagent.js";
import { ok, fail } from "./respond.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in YYYY-MM-DD, for ageing calculations. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerReportTools(server: McpServer): void {
  // ── Profit and loss ─────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_profit_and_loss",
    {
      description:
        "FreeAgent profit and loss summary — income, expenses, operating profit, " +
        "corporation tax estimate, dividends and retained profit. " +
        "Defaults to the current accounting year.",
      inputSchema: z
        .object({
          fromDate: z.string().regex(DATE).optional()
            .describe("Period start YYYY-MM-DD (default: start of the current accounting year)"),
          toDate: z.string().regex(DATE).optional()
            .describe("Period end YYYY-MM-DD (default: today)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const pnl = await getProfitAndLoss({
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
        return ok({ profit_and_loss: pnl });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Trial balance ───────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_trial_balance",
    {
      description:
        "FreeAgent trial balance — the balance on every nominal account. " +
        "Credits are negative, debits positive. Useful for a full financial position.",
      inputSchema: z
        .object({
          asAt: z.string().regex(DATE).optional()
            .describe("Balance date YYYY-MM-DD (default: today)"),
          nonZeroOnly: z.boolean().default(true)
            .describe("Omit accounts with a zero balance (default true)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const entries = await getTrialBalance({ asAt: args.asAt });
        const rows = entries
          .filter((e) => !args.nonZeroOnly || parseFloat(e.total) !== 0)
          .map((e) => ({
            nominal_code: e.nominal_code,
            name: e.name,
            total: e.total,
            category: e.category,
          }));
        const sum = rows.reduce((s, r) => s + (parseFloat(r.total) || 0), 0);
        return ok({
          accounts: rows,
          count: rows.length,
          // A balanced ledger sums to zero; a non-zero figure signals a problem.
          sumOfBalances: sum.toFixed(2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Aged debtors / creditors ────────────────────────────────────────────

  server.registerTool(
    "freeagent_aged_debtors",
    {
      description:
        "Aged debtors — unpaid customer invoices bucketed by how overdue they are " +
        "(not yet due, 1-30, 31-60, 61-90, 90+ days). Shows who owes what and for how long.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const invoices = await listInvoices({ view: "open_or_overdue", limit: 200 });
        const aged = buildAgeingBuckets(
          invoices.map((i) => ({
            label: i.contact_name ?? i.contact,
            reference: i.reference,
            dueOn: i.due_on,
            dueValue: i.due_value ?? "0",
          })),
          today()
        );
        return ok({
          totalOwedToUs: aged.total,
          buckets: aged.buckets,
          invoices: aged.items,
          count: aged.items.length,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "freeagent_aged_creditors",
    {
      description:
        "Aged creditors — unpaid supplier bills bucketed by how overdue they are. " +
        "Shows what the company owes and for how long.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const bills = await listBills({ view: "open_or_overdue", limit: 200 });
        const aged = buildAgeingBuckets(
          bills.map((b) => ({
            label: b.contact,
            reference: b.reference,
            dueOn: b.due_on,
            dueValue: b.due_value ?? "0",
          })),
          today()
        );
        return ok({
          totalWeOwe: aged.total,
          buckets: aged.buckets,
          bills: aged.items,
          count: aged.items.length,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Tax timeline ────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_tax_timeline",
    {
      description:
        "Upcoming tax and filing deadlines from FreeAgent — VAT returns, corporation tax, " +
        "Companies House filings, self assessment — with amounts due and dates.",
      inputSchema: z
        .object({
          includePersonal: z.boolean().default(true)
            .describe("Include personal (self assessment) items as well as company ones"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const items = await getTaxTimeline();
        const rows = items
          .filter((i) => args.includePersonal || !i.is_personal)
          .map((i) => ({
            description: i.description,
            nature: i.nature,
            dated_on: i.dated_on,
            amount_due: i.amount_due ?? null,
            is_personal: i.is_personal ?? false,
            status: i.status ?? null,
          }))
          .sort((a, b) => a.dated_on.localeCompare(b.dated_on));
        return ok({ timeline: rows, count: rows.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Company details ─────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_company_summary",
    {
      description:
        "FreeAgent company details — name, type, company registration number, " +
        "VAT registration status, accounting year end and currency.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const company = await getCompany();
        return ok({ company });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
