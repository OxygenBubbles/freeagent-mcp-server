import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createExpense,
  listCategories,
  listBankTransactions,
  linkExpenseToEntry,
  uploadAttachment,
  handleFAError,
} from "../services/freeagent.js";
import {
  DEFAULT_VENDOR_CATEGORIES,
  DATE_TOLERANCE_DAYS,
  AMOUNT_TOLERANCE,
} from "../constants.js";

// ── Vendor → category mapping ────────────────────────────────────────────────

function getVendorCategories(): Record<string, string> {
  let custom: Record<string, string> = {};
  try {
    if (process.env.VENDOR_CATEGORIES) {
      custom = JSON.parse(process.env.VENDOR_CATEGORIES) as Record<string, string>;
    }
  } catch {
    // ignore malformed JSON
  }
  return { ...DEFAULT_VENDOR_CATEGORIES, ...custom };
}

function lookupCategory(vendor: string): string | undefined {
  const vendorCategories = getVendorCategories();
  // Exact match first
  if (vendorCategories[vendor]) return vendorCategories[vendor];
  // Fuzzy match
  const upper = vendor.toUpperCase();
  for (const [pattern, url] of Object.entries(vendorCategories)) {
    if (upper.includes(pattern.toUpperCase())) return url;
  }
  return undefined;
}

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
          group: c.group ?? null,
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
            .describe("Vendor / merchant name (e.g. 'IONOS Cloud')"),
          datedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Expense date YYYY-MM-DD"),
          grossAmount: z
            .string()
            .min(1)
            .describe("Gross amount as string (e.g. '22.80')"),
          description: z
            .string()
            .min(1)
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
            .optional()
            .describe("FreeAgent category URL (e.g. '/v2/categories/285'). Auto-selected from vendor if omitted."),
          fileBase64: z
            .string()
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
        let categoryUrl = args.categoryUrl ?? lookupCategory(args.vendor);
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

        // Create expense
        const expense = await createExpense({
          categoryUrl,
          datedOn: args.datedOn,
          description: `${args.vendor} — ${args.description}`,
          grossValue: args.grossAmount,
          currency: args.currency,
          manualSalesTaxAmount: args.vatAmount,
        });

        const actions: string[] = [`Expense created (${expense.id})`];

        // Attach receipt if provided
        if (args.fileBase64 && args.fileName) {
          const ct = args.contentType ?? inferContentType(args.fileName);
          await uploadAttachment({
            entityId: expense.id,
            entityType: "expense",
            fileName: args.fileName,
            contentType: ct,
            fileBase64: args.fileBase64,
          });
          actions.push(`Receipt attached: ${args.fileName}`);
        }

        // Auto-match bank transaction if requested
        let matchedEntryId: string | null = null;
        if (args.bankAccountId) {
          const fromDate = new Date(args.datedOn);
          fromDate.setDate(fromDate.getDate() - DATE_TOLERANCE_DAYS);
          const toDate = new Date(args.datedOn);
          toDate.setDate(toDate.getDate() + DATE_TOLERANCE_DAYS);

          const transactions = await listBankTransactions({
            bankAccountId: args.bankAccountId,
            view: "unexplained",
            fromDate: fromDate.toISOString().split("T")[0],
            toDate: toDate.toISOString().split("T")[0],
            limit: 100,
          });

          const amount = Math.abs(parseFloat(args.grossAmount));
          const upperVendor = args.vendor.toUpperCase();
          const match = transactions.find((t) => {
            const amountMatch =
              Math.abs(Math.abs(parseFloat(t.amount)) - amount) <= AMOUNT_TOLERANCE;
            const descMatch = t.description.toUpperCase().includes(upperVendor);
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

// ── Content type inference ────────────────────────────────────────────────────

function inferContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    default: return "application/octet-stream";
  }
}
