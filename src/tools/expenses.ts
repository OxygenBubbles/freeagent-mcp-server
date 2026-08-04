import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createExpense,
  listCategories,
  listProjects,
  listBankTransactions,
  linkExpenseToEntry,
  handleFAError,
} from "../services/freeagent.js";
import { DATE_TOLERANCE_DAYS, AMOUNT_TOLERANCE } from "../constants.js";
import { inferContentType } from "../utils/contentType.js";
import { parseAmount, addDays } from "../utils/amount.js";
import { lookupCategory } from "../utils/vendorCategories.js";

// Max ~7.5 MB binary when decoded
const FILE_BASE64_MAX = 10_000_000;

// Category reference: the "/v2/categories/<id>" path form or the full API URL.
const CATEGORY_PATH_REGEX =
  /^(?:https:\/\/api\.freeagent\.com)?\/v2\/categories\/\d+$/;

// Project reference: the "/v2/projects/<id>" path form or the full API URL.
const PROJECT_PATH_REGEX = /^(?:https:\/\/api\.freeagent\.com)?\/v2\/projects\/\d+$/;

// Minimum vendor string length for fuzzy bank transaction matching
const MIN_VENDOR_MATCH_LEN = 3;

// ── Tool registration ────────────────────────────────────────────────────────

export function registerExpenseTools(server: McpServer): void {
  // ── List categories ─────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_categories",
    {
      description:
        "List FreeAgent expense categories (chart of accounts). " +
        "Returns category URL, description, nominal code and group. " +
        "Use the category URL when creating expenses or explaining transactions. Cached after first call.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const categories = await listCategories();
        const rows = categories.map((c) => ({
          url: c.url,
          description: c.description,
          nominal_code: c.nominal_code,
          group: c.group_description ?? c.group ?? null,
          category_type: c.category_type ?? null,
          allowable_for_tax: c.allowable_for_tax ?? null,
          auto_sales_tax_rate: c.auto_sales_tax_rate ?? null,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ categories: rows, count: rows.length }, null, 2),
            },
          ],
          structuredContent: { categories: rows, count: rows.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );

  // ── List projects ───────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_projects",
    {
      description:
        "List FreeAgent projects. Returns project URL, name, status and contact. " +
        "Use the project URL to tag an expense to a client engagement via freeagent_create_expense.",
      inputSchema: z
        .object({
          view: z
            .enum(["active", "completed", "cancelled", "all"])
            .default("active")
            .describe("Which projects to return (default: active)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const projects = await listProjects(args.view);
        const rows = projects.map((p) => ({
          url: p.url,
          id: p.id,
          name: p.name,
          status: p.status,
          contact: p.contact ?? null,
          currency: p.currency ?? null,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ projects: rows, count: rows.length }, null, 2),
            },
          ],
          structuredContent: { projects: rows, count: rows.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );

  // ── Create expense ──────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_create_expense",
    {
      description:
        "Create an expense in FreeAgent — for purchases on a personal card or cash that need claiming back. " +
        "Provide vendor, date, amount, description and category. If categoryUrl is omitted, auto-selects from vendor mapping. " +
        "Optionally pass bankAccountId to auto-match and explain a corresponding bank transaction (e.g. if the same purchase also appears on a company card).\n\n" +
        "RECEIPTS: Before asking the user for a file, search connected email tools (Gmail, Outlook/M365) for a matching invoice. " +
        "Use vendor name, amount and date as search terms. Download the PDF and pass it as fileBase64 + fileName. " +
        "Also check local sources (Downloads folder, etc.) if the user has mentioned them.",
      inputSchema: z
        .object({
          vendor: z
            .string()
            .min(1)
            .max(200)
            .describe("Vendor / merchant name (e.g. 'IONOS Cloud')"),
          datedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Expense date YYYY-MM-DD"),
          grossAmount: z
            .string()
            .min(1)
            .refine(
              (val) => Number.isFinite(parseFloat(val)) && parseFloat(val) > 0,
              "Must be a valid positive number (e.g. '22.80')"
            )
            .describe("Gross amount as string (e.g. '22.80')"),
          description: z
            .string()
            .min(1)
            .max(1000)
            .describe("Expense description (e.g. 'Monthly cloud hosting')"),
          currency: z
            .string()
            .length(3)
            .default("GBP")
            .describe("ISO 4217 currency code (default GBP)"),
          vatAmount: z
            .string()
            .optional()
            .describe("VAT amount as string (e.g. '3.80')"),
          categoryUrl: z
            .string()
            .regex(CATEGORY_PATH_REGEX, "Must be a FreeAgent category path like /v2/categories/285")
            .optional()
            .describe("FreeAgent category URL (e.g. '/v2/categories/285'). Auto-selected from vendor if omitted."),
          project: z
            .string()
            .regex(PROJECT_PATH_REGEX, "Must be a FreeAgent project path like /v2/projects/123")
            .optional()
            .describe(
              "FreeAgent project URL (e.g. '/v2/projects/123') to tag the expense against, " +
              "so it can be rebilled or reported per client. Use freeagent_list_projects to find it."
            ),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under ~7.5 MB (10 MB base64)")
            .optional()
            .describe("Base64-encoded receipt file (PDF, PNG, JPEG, etc.)"),
          fileName: z
            .string()
            .optional()
            .describe("File name for the receipt (e.g. 'receipt.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type (e.g. 'application/pdf'). Inferred from fileName if omitted."),
          bankAccountId: z
            .string()
            .optional()
            .describe(
              "If supplied, search this bank account for a matching unexplained transaction " +
              "(same amount, date ±4 days) and link the expense to it."
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        // Resolve category
        const categoryUrl = args.categoryUrl ?? lookupCategory(args.vendor);
        if (!categoryUrl) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: true,
                    message:
                      `No category mapping for "${args.vendor}". ` +
                      "Supply categoryUrl or use freeagent_list_categories to find the right one.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        // Attach the receipt inline on create, so a rejected attachment fails
        // the whole call rather than leaving a receiptless expense behind.
        const attachment =
          args.fileBase64 && args.fileName
            ? {
                fileName: args.fileName,
                contentType: args.contentType ?? inferContentType(args.fileName),
                fileBase64: args.fileBase64,
              }
            : undefined;

        // Create expense
        const expense = await createExpense({
          categoryUrl,
          datedOn: args.datedOn,
          description: `${args.vendor} — ${args.description}`,
          grossValue: args.grossAmount,
          currency: args.currency,
          manualSalesTaxAmount: args.vatAmount,
          projectUrl: args.project,
          attachment,
        });

        const actions: string[] = [`Expense created (${expense.id})`];
        if (attachment) actions.push(`Receipt attached: ${attachment.fileName}`);
        if (args.project) actions.push(`Tagged to project ${args.project}`);

        // Auto-match bank transaction if requested
        let matchedEntryId: string | null = null;
        if (args.bankAccountId) {
          const fromDate = addDays(args.datedOn, -DATE_TOLERANCE_DAYS);
          const toDate = addDays(args.datedOn, DATE_TOLERANCE_DAYS);

          const transactions = await listBankTransactions({
            bankAccountId: args.bankAccountId,
            view: "unexplained",
            fromDate,
            toDate,
            limit: 100,
          });

          const amount = parseAmount(args.grossAmount, "grossAmount");
          const upperVendor = args.vendor.toUpperCase();

          const match = transactions.find((t) => {
            const txAmount = parseFloat(t.amount);
            if (!Number.isFinite(txAmount)) return false;
            const amountMatch = Math.abs(Math.abs(txAmount) - amount) <= AMOUNT_TOLERANCE;
            const descMatch =
              upperVendor.length >= MIN_VENDOR_MATCH_LEN &&
              t.description.toUpperCase().includes(upperVendor);
            return amountMatch && descMatch;
          });

          if (match) {
            await linkExpenseToEntry({
              entryId: match.id,
              expenseUrl: expense.url,
            });
            matchedEntryId = match.id;
            actions.push(`Linked to bank transaction ${match.id} (${match.description}, ${match.amount})`);
          } else {
            actions.push("No matching bank transaction found — expense stands alone as a claim");
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  expenseId: expense.id,
                  expenseUrl: expense.url,
                  amount: expense.gross_value,
                  category: expense.category,
                  matchedBankEntry: matchedEntryId,
                  actions,
                },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            success: true,
            expenseId: expense.id,
            matchedBankEntry: matchedEntryId,
            actions,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );
}
