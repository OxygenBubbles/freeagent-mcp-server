import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listBankTransactions,
  updateExplanation,
  uploadAttachment,
  handleFAError,
} from "../services/freeagent.js";

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
          fromDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Start date filter YYYY-MM-DD (inclusive)"),
          toDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("End date filter YYYY-MM-DD (inclusive)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .default(50)
            .describe("Max entries to return (default 50, max 200)"),
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
        "- Attach a receipt/invoice file (pass fileBase64 + fileName)\n" +
        "Get the explanationId from freeagent_list_transactions (explanation_id field).\n\n" +
        "RECEIPTS: Before asking the user for a file, search connected email tools (Gmail, Outlook/M365) " +
        "for a matching invoice using vendor name, amount and date. Download the PDF from the email and pass it as fileBase64. " +
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
            .optional()
            .describe("FreeAgent category path (e.g. '/v2/categories/285'). Use freeagent_list_categories to find the right one."),
          markExplained: z
            .boolean()
            .default(false)
            .describe("Set true to approve/reconcile the transaction. Only do this when evidence is attached or confirmed."),
          fileBase64: z
            .string()
            .optional()
            .describe("Base64-encoded file to attach (receipt, invoice, screenshot — PDF, PNG, JPEG, etc.)"),
          fileName: z
            .string()
            .optional()
            .describe("File name for the attachment (e.g. 'ionos-invoice-apr-2026.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type of the file (e.g. 'application/pdf', 'image/jpeg', 'image/png'). Inferred from fileName if omitted."),
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

        // 1. Attach file if provided
        let attachmentUrl: string | undefined;
        if (args.fileBase64 && args.fileName) {
          const ct =
            args.contentType ?? inferContentType(args.fileName);
          const att = await uploadAttachment({
            entityId: args.explanationId,
            entityType: "bank_transaction_explanation",
            fileName: args.fileName,
            contentType: ct,
            fileBase64: args.fileBase64,
          });
          attachmentUrl = att.url;
          actions.push(`Attached ${att.file_name} (${att.file_size} bytes)`);
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

// ── Content type inference ────────────────────────────────────────────────────

function inferContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "tiff":
    case "tif":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}
