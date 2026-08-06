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
import { REPORT_MAX_RECORDS } from "../constants.js";
import { sumResponseMoney } from "../utils/money.js";
import { ok, fail } from "./respond.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date to age against.
 *
 * `new Date().toISOString()` is UTC, which is the wrong accounting day for
 * anyone west of Greenwich in the evening (and can be a day early east of it).
 * Ageing is computed in the host's local calendar day, and callers can pass an
 * explicit `asAt` when they need a specific reporting date.
 */
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
        const sum = sumResponseMoney(
          rows.map((r) => r.total),
          "trial balance total"
        );
        return ok({
          accounts: rows,
          count: rows.length,
          // A balanced ledger sums to zero; a non-zero figure signals a problem.
          sumOfBalances: sum,
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
      inputSchema: z
        .object({
          asAt: z
            .string()
            .regex(DATE)
            .optional()
            .describe("Age against this date YYYY-MM-DD (default: today)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        // Reports must cover the whole ledger, so this pages to exhaustion
        // rather than reading a single page.
        const { items, mayHaveMore } = await listInvoices({
          view: "open_or_overdue",
          limit: REPORT_MAX_RECORDS,
        });
        const aged = buildAgeingBuckets(
          items.map((i) => ({
            label: i.contact_name ?? i.contact,
            reference: i.reference,
            dueOn: i.due_on,
            dueValue: i.due_value ?? "0",
          })),
          args.asAt ?? localToday()
        );
        return ok({
          asAt: args.asAt ?? localToday(),
          totalOwedToUs: aged.total,
          buckets: aged.buckets,
          invoices: aged.items,
          count: aged.items.length,
          unknownDueDateCount: aged.unknownDueDateCount,
          complete: !mayHaveMore,
          ...(mayHaveMore
            ? { warning: `More than ${REPORT_MAX_RECORDS} open invoices exist; this total is incomplete.` }
            : {}),
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
      inputSchema: z
        .object({
          asAt: z
            .string()
            .regex(DATE)
            .optional()
            .describe("Age against this date YYYY-MM-DD (default: today)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const { items, mayHaveMore } = await listBills({
          view: "open_or_overdue",
          limit: REPORT_MAX_RECORDS,
        });
        const aged = buildAgeingBuckets(
          items.map((b) => ({
            label: b.contact,
            reference: b.reference,
            dueOn: b.due_on,
            dueValue: b.due_value ?? "0",
          })),
          args.asAt ?? localToday()
        );
        return ok({
          asAt: args.asAt ?? localToday(),
          totalWeOwe: aged.total,
          buckets: aged.buckets,
          bills: aged.items,
          count: aged.items.length,
          unknownDueDateCount: aged.unknownDueDateCount,
          complete: !mayHaveMore,
          ...(mayHaveMore
            ? { warning: `More than ${REPORT_MAX_RECORDS} open bills exist; this total is incomplete.` }
            : {}),
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
