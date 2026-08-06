import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  listBankTransactions,
  updateExplanation,
  uploadAttachment,
  deleteExistingAttachment,
  fetchUrlAsBase64,
  handleFAError,
} from "../services/freeagent.js";
import { inferContentType } from "../utils/contentType.js";
import { dateSchema } from "./respond.js";

// Max ~7.5 MB binary when decoded
const FILE_BASE64_MAX = 10_000_000;

// Category path must be /v2/categories/<numeric-id>
const CATEGORY_PATH_REGEX = /^\/v2\/categories\/\d+$/;

export function registerTransactionTools(server: McpServer): void {
  // ── List transactions ───────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_transactions",
    {
      description:
        "List bank account transactions from FreeAgent. By default returns unexplained (unreconciled) transactions. " +
        "Use bankAccountId from freeagent_list_bank_accounts. " +
        "Returns id, date, description, amount, and explanation details (category, marked_for_review) for each entry. " +
        "After listing, if the task involves reconciliation, search available email or file sources for matching receipts — " +
        "do not ask the user to provide files before checking email (Gmail, Outlook, etc.) and local sources first.",
      inputSchema: z
        .object({
          bankAccountId: z
            .string()
            .min(1)
            .describe("Numeric FreeAgent bank account ID (e.g. '1877156')"),
          view: z
            .enum(["unexplained", "explained", "all", "marked_for_review", "manual", "imported"])
            .default("unexplained")
            .describe("Which transactions to return. Defaults to unexplained. Use 'marked_for_review' for auto-categorised transactions awaiting approval."),
          fromDate: dateSchema("Start date filter YYYY-MM-DD (inclusive)").optional(),
          toDate: dateSchema("End date filter YYYY-MM-DD (inclusive)").optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(50)
            .describe("Max entries to return (default 50, max 100)"),
          page: z
            .number()
            .int()
            .min(1)
            .default(1)
            .describe("Page number for pagination (default 1)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const transactions = await listBankTransactions({
          bankAccountId: args.bankAccountId,
          view: args.view,
          fromDate: args.fromDate,
          toDate: args.toDate,
          limit: args.limit,
          page: args.page,
        });

        const rows = transactions.map((t) => {
          const exp = t.bank_transaction_explanations?.[0];
          return {
            id: t.id,
            dated_on: t.dated_on,
            description: t.description,
            amount: t.amount,
            is_manual: t.is_manual,
            explanation_id: exp?.id ?? null,
            explanation_description: exp?.description ?? null,
            category: exp?.category ?? null,
            marked_for_review: exp?.marked_for_review ?? null,
            sales_tax_value: exp?.sales_tax_value ?? null,
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ transactions: rows, count: rows.length }, null, 2),
            },
          ],
          structuredContent: { transactions: rows, count: rows.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );

  // ── Explain transaction ─────────────────────────────────────────────────

  server.registerTool(
    "freeagent_explain_transaction",
    {
      description:
        "Approve or update a FreeAgent bank transaction explanation. Use this to:\n" +
        "- Approve a 'marked for review' transaction (set markExplained=true)\n" +
        "- Change the category or description of an explanation\n" +
        "- Attach a receipt/invoice — PREFER filePath (a local file) or fileUrl (a download link); the server reads/encodes it. Re-attaching replaces any existing attachment.\n" +
        "Get the explanationId from freeagent_list_transactions (explanation_id field).\n\n" +
        "RECEIPTS: Before asking the user for a file, search connected email tools (Gmail, Outlook/M365) " +
        "for a matching invoice using vendor name, amount and date. Pass a download link as fileUrl, or save the PDF locally and pass filePath. " +
        "Avoid fileBase64 for anything but tiny files — large inline base64 is unreliable. " +
        "Also check local file sources (Downloads folder, etc.) if the user has mentioned them.\n\n" +
        "SAFETY: Only set markExplained=true when you have a confirmed receipt attached or the user has explicitly approved it.",
      inputSchema: z
        .object({
          explanationId: z
            .string()
            .min(1)
            .describe("Numeric FreeAgent bank transaction explanation ID (from explanation_id in list_transactions)"),
          description: z
            .string()
            .optional()
            .describe("Human-readable description for the transaction (e.g. 'IONOS — Monthly cloud hosting')"),
          category: z
            .string()
            .regex(CATEGORY_PATH_REGEX, "Must be a FreeAgent category path like /v2/categories/285")
            .optional()
            .describe("FreeAgent category path (e.g. '/v2/categories/285'). Use freeagent_list_categories to find the right one."),
          markExplained: z
            .boolean()
            .default(false)
            .describe("Set true to approve/reconcile the transaction. Only do this when evidence is attached or confirmed."),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under ~7.5 MB (10 MB base64)")
            .optional()
            .describe("Base64-encoded file to attach (receipt, invoice, screenshot — PDF, PNG, JPEG, etc.)"),
          fileName: z
            .string()
            .optional()
            .describe("File name for the attachment (e.g. 'ionos-invoice-apr-2026.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type of the file (e.g. 'application/pdf', 'image/jpeg', 'image/png'). Inferred from fileName/filePath if omitted."),
          filePath: z
            .string()
            .optional()
            .describe("Absolute path to a local file to attach (e.g. '/Users/you/Downloads/invoice.pdf'). The SERVER reads and base64-encodes it — PREFER THIS over fileBase64, which is unreliable for non-trivial files. fileName defaults to the file's name."),
          fileUrl: z
            .string()
            .url()
            .optional()
            .describe("URL of a receipt to download and attach (e.g. a Stripe 'Download invoice' link). The server fetches and encodes it — no need to handle bytes."),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const actions: string[] = [];

        // 1. Attach file if provided — resolve bytes from filePath / fileUrl / fileBase64.
        let attachmentUrl: string | undefined;
        let fileBase64 = args.fileBase64;
        let fileName = args.fileName;
        let contentType = args.contentType;
        if (!fileBase64 && args.filePath) {
          const buf = await readFile(args.filePath);
          fileBase64 = buf.toString("base64");
          fileName = fileName ?? basename(args.filePath);
        }
        if (!fileBase64 && args.fileUrl) {
          const fetched = await fetchUrlAsBase64(args.fileUrl);
          fileBase64 = fetched.base64;
          fileName = fileName ?? fetched.fileName ?? "attachment.pdf";
          contentType = contentType ?? fetched.contentType;
        }
        if (fileBase64) {
          if (fileBase64.length > FILE_BASE64_MAX) {
            throw new Error("File too large to attach (over ~7.5 MB).");
          }
          const name = fileName ?? "attachment.pdf";
          const ct = contentType ?? inferContentType(name);
          // FreeAgent won't overwrite an existing attachment via PUT — remove it first.
          const replaced = await deleteExistingAttachment(args.explanationId).catch(() => false);
          const att = await uploadAttachment({
            entityId: args.explanationId,
            entityType: "bank_transaction_explanation",
            fileName: name,
            contentType: ct,
            fileBase64,
          });
          attachmentUrl = att.url;
          actions.push(
            `Attached ${att.file_name} (${att.file_size} bytes)${replaced ? " (replaced previous)" : ""}`
          );
        }

        // 2. Update explanation (category, description, approve)
        const needsUpdate =
          args.description !== undefined ||
          args.category !== undefined ||
          args.markExplained;

        let explanation;
        if (needsUpdate) {
          explanation = await updateExplanation({
            explanationId: args.explanationId,
            description: args.description,
            category: args.category,
            markExplained: args.markExplained,
          });
          if (args.description) actions.push(`Description set to "${args.description}"`);
          if (args.category) actions.push(`Category set to ${args.category}`);
          if (args.markExplained) actions.push("Approved (marked_for_review cleared)");
        }

        if (actions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No changes requested. Supply at least one of: description, category, markExplained, or fileBase64.",
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  explanationId: args.explanationId,
                  actions,
                  attachmentUrl: attachmentUrl ?? null,
                  marked_for_review: explanation?.marked_for_review ?? null,
                },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            success: true,
            explanationId: args.explanationId,
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
