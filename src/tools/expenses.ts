import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createExpense,
  updateExpense,
  deleteExpense,
  getExpense,
  replaceAttachment,
  listCategories,
  listBankTransactions,
  linkExpenseToEntry,
  handleFAError,
} from "../services/freeagent.js";
import { DATE_TOLERANCE_DAYS, AMOUNT_TOLERANCE_PENCE } from "../constants.js";
import {
  checkAttachmentSource,
  resolveAttachmentSource,
  hasAttachmentSource,
} from "../utils/attachmentSource.js";
import { parseAmount, addDays } from "../utils/amount.js";
import { findMatchingTransactions, decideLink } from "../utils/matchTransaction.js";
import { lookupCategory } from "../utils/vendorCategories.js";
import { dateSchema, invalid, ok, fail } from "./respond.js";

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

  server.registerTool(
    "freeagent_create_expense",
    {
      description:
        "Create an expense in FreeAgent — for purchases on a personal card or cash that need claiming back. " +
        "Provide vendor, date, amount, description and category. If categoryUrl is omitted, auto-selects from vendor mapping. " +
        "Optionally pass bankAccountId to auto-match and explain a corresponding bank transaction (e.g. if the same purchase also appears on a company card).\n\n" +
        "RECEIPTS: PREFER filePath (a local file — screenshot, PDF, whatever) or fileUrl (a download link); the server reads and encodes it. " +
        "Avoid fileBase64 for anything but tiny files — large inline base64 is unreliable and the expense lands receiptless. " +
        "Before asking the user for a file, search connected email tools (Gmail, Outlook/M365) for a matching invoice " +
        "using vendor name, amount and date, and check local sources (Downloads folder, etc.) if the user has mentioned them.",
      inputSchema: z
        .object({
          vendor: z
            .string()
            .min(1)
            .max(200)
            .describe("Vendor / merchant name (e.g. 'IONOS Cloud')"),
          datedOn: dateSchema("Expense date YYYY-MM-DD"),
          grossAmount: z
            .string()
            .regex(
              /^\d+(\.\d{1,2})?$/,
              "Positive amount with at most 2 decimal places, e.g. '22.80'"
            )
            .refine((v) => Number(v) > 0, "Must be greater than zero")
            .describe("Gross amount as string (e.g. '22.80')"),
          description: z
            .string()
            .min(1)
            .max(1000)
            .describe("Expense description (e.g. 'Monthly cloud hosting')"),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP")
            .default("GBP")
            .describe("ISO 4217 currency code (default GBP)"),
          vatAmount: z
            .string()
            .regex(
              /^\d+(\.\d{1,2})?$/,
              "Positive amount with at most 2 decimal places, e.g. '3.80'"
            )
            .optional()
            .describe("VAT amount as string (e.g. '3.80'). Use vatRate instead to let FreeAgent work it out."),
          vatRate: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Percentage, e.g. '20.0'")
            .refine((v) => Number(v) <= 100, "VAT rate cannot exceed 100%")
            .optional()
            .describe("VAT rate as a percentage (e.g. '20.0') — FreeAgent calculates the amount"),
          receiptReference: z
            .string()
            .max(100)
            .optional()
            .describe("Supplier's own receipt or invoice number, for matching against a paper trail"),
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
          rebillType: z
            .enum(["cost", "markup", "price"])
            .optional()
            .describe(
              "How to rebill this to the client — 'cost' bills it on at cost, 'markup' adds a " +
              "percentage, 'price' charges a fixed price. Requires project. Without it the expense " +
              "is attributed to the project but never queued to bill on."
            ),
          rebillFactor: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '15.0'")
            .optional()
            .describe("Markup percentage or fixed price — required for markup/price"),
          ecStatus: z
            .enum(["UK/Non-EC", "EC Goods", "EC Services", "Reverse Charge"])
            .optional()
            .describe(
              "VAT treatment for the purchase. Defaults to 'UK/Non-EC' — set it for an overseas " +
              "supplier or a reverse-charge purchase, or the VAT return reports it in the wrong box."
            ),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under ~7.5 MB (10 MB base64)")
            .optional()
            .describe(
              "Base64-encoded receipt. LAST RESORT — unreliable above a few hundred KB; " +
              "prefer filePath or fileUrl."
            ),
          fileName: z
            .string()
            .optional()
            .describe("File name for the receipt (e.g. 'receipt.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type (e.g. 'application/pdf'). Inferred from fileName if omitted."),
          filePath: z
            .string()
            .optional()
            .describe(
              "Absolute path to a local receipt file (e.g. '/Users/you/Desktop/screenshot.png'). " +
              "The SERVER reads and base64-encodes it — PREFER THIS over fileBase64. " +
              "fileName defaults to the file's name."
            ),
          fileUrl: z
            .string()
            .url()
            .optional()
            .describe(
              "URL of a receipt to download and attach (e.g. a Stripe 'Download invoice' link). " +
              "The server fetches and encodes it — no need to handle bytes."
            ),
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
      // NOTE: this check is NOT a schema-level .refine(). Calling .refine() on
      // the object turns it into a ZodEffects, which the MCP SDK cannot read a
      // .shape from — it then advertises an EMPTY inputSchema, so clients see
      // no parameters and send none. Cross-field rules belong in the handler.
    async (args) => {
      try {
        const badSource = checkAttachmentSource(args);
        if (badSource) return invalid(badSource);

        if (args.vatAmount && args.vatRate) {
          return invalid(
            "Supply vatAmount or vatRate, not both — FreeAgent applies one and silently ignores the other."
          );
        }

        if (args.rebillType && !args.project) {
          return invalid(
            "rebillType needs a project — FreeAgent rebills an expense to the project it is tagged against."
          );
        }
        if (
          (args.rebillType === "markup" || args.rebillType === "price") &&
          !args.rebillFactor
        ) {
          return invalid(
            `rebillType '${args.rebillType}' needs rebillFactor (the markup percentage or fixed price).`
          );
        }

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
        const attachment = await resolveAttachmentSource(args, {
          maxBase64: FILE_BASE64_MAX,
          sizeLabel: "~7.5 MB",
        });

        // Create expense
        const expense = await createExpense({
          categoryUrl,
          datedOn: args.datedOn,
          description: `${args.vendor} — ${args.description}`,
          grossValue: args.grossAmount,
          currency: args.currency,
          salesTaxRate: args.vatRate,
          manualSalesTaxAmount: args.vatAmount,
          receiptReference: args.receiptReference,
          projectUrl: args.project,
          rebillType: args.rebillType,
          rebillFactor: args.rebillFactor,
          ecStatus: args.ecStatus,
          attachment,
        });

        const actions: string[] = [`Expense created (${expense.id})`];
        if (attachment) actions.push(`Receipt attached: ${attachment.fileName}`);
        if (args.project) {
          actions.push(
            args.rebillType
              ? `Tagged to project ${args.project}, rebill ${args.rebillType}${
                  args.rebillFactor ? ` (${args.rebillFactor})` : ""
                }`
              : `Tagged to project ${args.project} (not set to rebill)`
          );
        }

        // Auto-match bank transaction if requested
        let matchedEntryId: string | null = null;
        if (args.bankAccountId) {
          const fromDate = addDays(args.datedOn, -DATE_TOLERANCE_DAYS);
          const toDate = addDays(args.datedOn, DATE_TOLERANCE_DAYS);

          // The window is narrow, but a busy account can hold more than a
          // page of unexplained rows in it; under-fetching silently reported
          // "no match" and left a standalone claim.
          const { items: transactions, mayHaveMore: moreCandidates } =
            await listBankTransactions({
            bankAccountId: args.bankAccountId,
            view: "unexplained",
            fromDate,
            toDate,
            limit: 500,
            });

          const amount = parseAmount(args.grossAmount, "grossAmount");
          const upperVendor = args.vendor.toUpperCase();

          const matches = findMatchingTransactions(transactions, {
            amount: args.grossAmount,
            vendor: args.vendor,
            tolerancePence: AMOUNT_TOLERANCE_PENCE,
            minVendorLength: MIN_VENDOR_MATCH_LEN,
          });
          const decision = decideLink(matches, moreCandidates);

          if (decision.action === "link") {
            await linkExpenseToEntry({
              entryId: decision.match.id,
              expenseUrl: expense.url,
            });
            matchedEntryId = decision.match.id;
            actions.push(
              `Linked to bank transaction ${decision.match.id} (${decision.match.description}, ${decision.match.amount})`
            );
          } else if (decision.action === "ambiguous") {
            actions.push(
              `Not linked: ${decision.matches.length} bank transactions match (${decision.matches
                .map((m) => `${m.id} ${m.dated_on} ${m.amount}`)
                .join("; ")}). Link the right one manually.`
            );
          } else if (decision.action === "incomplete") {
            actions.push(
              `Not linked: found one match (${decision.matches[0]!.id}) but more unexplained transactions exist beyond the ${transactions.length} searched, so it may not be the only candidate. Confirm manually.`
            );
          } else {
            // "No match" over a truncated candidate set reads as "no such
            // transaction exists", and the user files a duplicate.
            actions.push(
              moreCandidates
                ? `No match in the first ${transactions.length} unexplained transactions in the date window, but more exist — expense stands alone as a claim; check manually`
                : "No matching bank transaction found — expense stands alone as a claim"
            );
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

  // ── Update expense ──────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_expense",
    {
      description:
        "Update an existing FreeAgent expense: attach or replace its receipt, set the rebill treatment, " +
        "retag the project or category, or correct the date, amount, VAT or description.\n\n" +
        "Use this to fix an expense that was filed without a receipt, or tagged to a project but never " +
        "queued to rebill. Only the fields you pass are changed; everything else is left alone.\n\n" +
        "RECEIPTS: PREFER filePath (a local file) or fileUrl (a download link) — the server reads and encodes it. " +
        "Avoid fileBase64 for anything but tiny files. FreeAgent will not overwrite an attachment in place, " +
        "so an existing receipt is deleted first and the new one replaces it.",
      inputSchema: z
        .object({
          expenseId: z
            .string()
            .regex(/^\d+$/, "Numeric FreeAgent expense ID, e.g. '12345678'")
            .describe("Numeric FreeAgent expense ID (the expenseId returned by freeagent_create_expense)"),
          project: z
            .string()
            .regex(
              new RegExp(`${PROJECT_PATH_REGEX.source}|^$`),
              "Must be a FreeAgent project path like /v2/projects/123, or '' to untag"
            )
            .optional()
            .describe(
              "FreeAgent project URL to tag the expense against. Pass '' to remove the project tag."
            ),
          rebillType: z
            .enum(["cost", "markup", "price", ""])
            .optional()
            .describe(
              "How to rebill this to the client — 'cost' bills it on at cost, 'markup' adds a " +
              "percentage, 'price' charges a fixed price. The expense must be on a project. " +
              "Pass '' to stop it being rebilled."
            ),
          rebillFactor: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '15.0'")
            .optional()
            .describe("Markup percentage or fixed price — required for markup/price"),
          categoryUrl: z
            .string()
            .regex(CATEGORY_PATH_REGEX, "Must be a FreeAgent category path like /v2/categories/285")
            .optional()
            .describe("FreeAgent category URL to move the expense to"),
          description: z
            .string()
            .min(1)
            .max(1000)
            .optional()
            .describe("Replacement description"),
          datedOn: dateSchema("Corrected expense date YYYY-MM-DD").optional(),
          grossAmount: z
            .string()
            .regex(/^\d+(\.\d{1,2})?$/, "Positive amount with at most 2 decimal places")
            .refine((v) => Number(v) > 0, "Must be greater than zero")
            .optional()
            .describe("Corrected gross amount as string (e.g. '22.80')"),
          vatAmount: z
            .string()
            .regex(/^\d+(\.\d{1,2})?$/, "Positive amount with at most 2 decimal places")
            .optional()
            .describe("Corrected VAT amount as string (e.g. '3.80')"),
          vatRate: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Percentage, e.g. '20.0'")
            .refine((v) => Number(v) <= 100, "VAT rate cannot exceed 100%")
            .optional()
            .describe("Corrected VAT rate as a percentage (e.g. '20.0')"),
          receiptReference: z
            .string()
            .max(100)
            .optional()
            .describe("Supplier's own receipt or invoice number"),
          ecStatus: z
            .enum(["UK/Non-EC", "EC Goods", "EC Services", "Reverse Charge"])
            .optional()
            .describe("VAT treatment for the purchase (defaults to 'UK/Non-EC' when the expense was created)"),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under ~7.5 MB (10 MB base64)")
            .optional()
            .describe(
              "Base64-encoded receipt. LAST RESORT — unreliable above a few hundred KB; " +
              "prefer filePath or fileUrl."
            ),
          fileName: z
            .string()
            .optional()
            .describe("File name for the receipt (e.g. 'receipt.pdf'). Defaults to the local file's name."),
          contentType: z
            .string()
            .optional()
            .describe("MIME type (e.g. 'application/pdf'). Inferred from the file name if omitted."),
          filePath: z
            .string()
            .optional()
            .describe(
              "Absolute path to a local receipt file (e.g. '/Users/you/Desktop/screenshot.png'). " +
              "The SERVER reads and base64-encodes it — PREFER THIS over fileBase64."
            ),
          fileUrl: z
            .string()
            .url()
            .optional()
            .describe("URL of a receipt to download and attach. The server fetches and encodes it."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
      // NOTE: these checks are NOT schema-level .refine(). Calling .refine() on
      // the object turns it into a ZodEffects, which the MCP SDK cannot read a
      // .shape from — it then advertises an EMPTY inputSchema, so clients see
      // no parameters and send none. Cross-field rules belong in the handler.
    async (args) => {
      try {
        const badSource = checkAttachmentSource(args);
        if (badSource) return invalid(badSource);

        if (args.vatAmount && args.vatRate) {
          return invalid(
            "Supply vatAmount or vatRate, not both — FreeAgent applies one and silently ignores the other."
          );
        }

        if (
          (args.rebillType === "markup" || args.rebillType === "price") &&
          !args.rebillFactor
        ) {
          return invalid(
            `rebillType '${args.rebillType}' needs rebillFactor (the markup percentage or fixed price).`
          );
        }

        // Rebilling only means anything against a project. The expense may
        // already be on one, so check FreeAgent rather than demand it again.
        // An empty rebillType is a request to stop rebilling, so it needs none.
        if (args.rebillType && !args.project) {
          const current = await getExpense(args.expenseId);
          if (!current.project) {
            return invalid(
              "rebillType needs a project — this expense is not tagged to one. Pass project as well."
            );
          }
        }

        const fields = [
          args.project,
          args.rebillType,
          args.categoryUrl,
          args.description,
          args.datedOn,
          args.grossAmount,
          args.vatAmount,
          args.vatRate,
          args.receiptReference,
          args.ecStatus,
          // rebillFactor alone is a real change: switching a markup from 15%
          // to 20% touches nothing else.
          args.rebillFactor,
        ].filter((v) => v !== undefined);
        if (fields.length === 0 && !hasAttachmentSource(args)) {
          return invalid(
            "Nothing to update — supply a field to change or a receipt to attach."
          );
        }

        const actions: string[] = [];

        // The receipt goes on first: a rejected attachment then fails the call
        // before the field changes land, instead of half-applying.
        const attachment = await resolveAttachmentSource(args, {
          maxBase64: FILE_BASE64_MAX,
          sizeLabel: "~7.5 MB",
        });
        if (attachment) {
          const { attachment: att, replaced } = await replaceAttachment({
            entityId: args.expenseId,
            entityType: "expense",
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            fileBase64: attachment.fileBase64,
          });
          actions.push(
            `Attached ${att.file_name} (${att.file_size} bytes)${replaced ? " (replaced previous)" : ""}`
          );
        }

        let expense = await getExpense(args.expenseId);
        if (fields.length > 0) {
          expense = await updateExpense(args.expenseId, {
            projectUrl: args.project,
            rebillType: args.rebillType,
            rebillFactor: args.rebillFactor,
            categoryUrl: args.categoryUrl,
            description: args.description,
            datedOn: args.datedOn,
            grossValue: args.grossAmount,
            salesTaxRate: args.vatRate,
            manualSalesTaxAmount: args.vatAmount,
            receiptReference: args.receiptReference,
            ecStatus: args.ecStatus,
          });
          if (args.project !== undefined) {
            actions.push(
              args.project === ""
                ? "Project tag removed"
                : `Tagged to project ${args.project}`
            );
          }
          if (args.rebillType !== undefined) {
            actions.push(
              args.rebillType === ""
                ? "Rebilling turned off"
                : `Rebill set to ${args.rebillType}${args.rebillFactor ? ` (${args.rebillFactor})` : ""}`
            );
          }
          if (args.categoryUrl) actions.push(`Category set to ${args.categoryUrl}`);
          if (args.description) actions.push(`Description set to "${args.description}"`);
          if (args.datedOn) actions.push(`Date set to ${args.datedOn}`);
          if (args.grossAmount) actions.push(`Gross amount set to ${args.grossAmount}`);
          if (args.vatAmount) actions.push(`VAT set to ${args.vatAmount}`);
          if (args.vatRate) actions.push(`VAT rate set to ${args.vatRate}%`);
          if (args.receiptReference) {
            actions.push(`Receipt reference set to ${args.receiptReference}`);
          }
          if (args.ecStatus) actions.push(`EC status set to ${args.ecStatus}`);
        }

        return ok({
          success: true,
          expenseId: expense.id,
          expenseUrl: expense.url,
          amount: expense.gross_value,
          category: expense.category,
          project: expense.project ?? null,
          rebillType: expense.rebill_type ?? null,
          hasAttachment: Boolean(expense.attachment) || Boolean(attachment),
          actions,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete expense ──────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_expense",
    {
      description:
        "Permanently delete a FreeAgent expense. Use this for a duplicate or a claim filed in error — " +
        "to correct one, use freeagent_update_expense instead. " +
        "FreeAgent refuses if the expense has been explained against a bank transaction or billed on.",
      inputSchema: z
        .object({
          expenseId: z
            .string()
            .regex(/^\d+$/, "Numeric FreeAgent expense ID")
            .describe("Numeric FreeAgent expense ID"),
          confirm: z
            .boolean()
            .describe("Must be true — deleting an expense cannot be undone."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        if (!args.confirm) {
          return invalid("Pass confirm=true to delete the expense — this cannot be undone.");
        }
        // Read it first: once deleted there is nothing to show the user, and
        // "deleted expense 123" is not something they can check afterwards.
        const expense = await getExpense(args.expenseId).catch(() => null);
        await deleteExpense(args.expenseId);
        return ok({
          success: true,
          deletedExpenseId: args.expenseId,
          description: expense?.description ?? null,
          amount: expense?.gross_value ?? null,
          datedOn: expense?.dated_on ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
