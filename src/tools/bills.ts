import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listBills, createBill, deleteBill } from "../services/freeagent.js";
import { sumResponseMoney } from "../utils/money.js";
import { inferContentType } from "../utils/contentType.js";
import { ok, fail, resourceRegex, dateSchema } from "./respond.js";

const CONTACT_REF = resourceRegex("contacts");
const PROJECT_REF = resourceRegex("projects");
const CATEGORY_REF = resourceRegex("categories");

// FreeAgent caps bill attachments at 5 MB. Base64 inflates by 4/3, so 5 MB of
// file is ~6.99M characters; this bound keeps the decoded payload under the cap.
const FILE_BASE64_MAX = 6_990_000;

export function registerBillTools(server: McpServer): void {
  // ── List ────────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_bills",
    {
      description:
        "List FreeAgent bills — money the company owes to suppliers (accounts payable). " +
        "Use view='open_or_overdue' to see what is still to pay.",
      inputSchema: z
        .object({
          view: z
            .enum(["all", "open", "overdue", "open_or_overdue", "paid", "recurring"])
            .default("all")
            .describe("Which bills to return (default: all)"),
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .optional()
            .describe("Only bills from this supplier"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Only bills allocated to this project"),
          fromDate: dateSchema("Earliest bill date YYYY-MM-DD").optional(),
          toDate: dateSchema("Latest bill date YYYY-MM-DD").optional(),
          limit: z.number().int().positive().max(100).default(50)
            .describe("Maximum bills to return (default 50, max 100)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const { items, mayHaveMore } = await listBills({
          view: args.view,
          contactUrl: args.contact,
          projectUrl: args.project,
          fromDate: args.fromDate,
          toDate: args.toDate,
          limit: args.limit,
        });
        const rows = items.map((b) => ({
          url: b.url,
          id: b.id,
          reference: b.reference ?? null,
          contact: b.contact,
          status: b.status ?? null,
          dated_on: b.dated_on,
          due_on: b.due_on ?? null,
          paid_on: b.paid_on ?? null,
          currency: b.currency ?? null,
          total_value: b.total_value,
          due_value: b.due_value ?? null,
        }));
        const outstanding = sumResponseMoney(
          rows.map((r) => r.due_value),
          "bill due value"
        );
        return ok({
          bills: rows,
          count: rows.length,
          totalOutstandingForReturned: outstanding,
          mayHaveMore,
          ...(mayHaveMore
            ? { warning: `More bills exist beyond the ${args.limit} fetched — the total above is partial. Use freeagent_aged_creditors for a complete figure.` }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Create ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_create_bill",
    {
      description:
        "Record a supplier bill (an invoice the company has received and owes). " +
        "Each line needs a spending category and a value including tax.\n\n" +
        "RECEIPTS: before asking the user for the PDF, search connected email tools " +
        "(Gmail, Outlook/M365) for the supplier invoice and pass it as fileBase64 + fileName.",
      inputSchema: z
        .object({
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .describe("Supplier the bill is from — create one with freeagent_create_contact"),
          reference: z
            .string()
            .min(1)
            .max(100)
            .describe("Supplier's invoice reference (e.g. 'INV-2049')"),
          datedOn: dateSchema("Bill date YYYY-MM-DD"),
          dueOn: dateSchema("Payment due date YYYY-MM-DD"),
          items: z
            .array(
              z.object({
                categoryUrl: z
                  .string()
                  .regex(CATEGORY_REF, "Must be a category path like /v2/categories/285")
                  .describe("Spending category for this line"),
                totalValue: z
                  .string()
                  .regex(
                    /^\d+(\.\d{1,2})?$/,
                    "Positive amount with at most 2 decimal places, e.g. '120.00'"
                  )
                  .describe(
                    "Line value INCLUDING tax (e.g. '120.00'). Must be positive — " +
                    "a supplier credit is a credit note, not a negative bill line."
                  ),
                description: z.string().max(500).optional().describe("Line description"),
                salesTaxRate: z
                  .string()
                  .regex(/^\d+(\.\d+)?$/, "Percentage, e.g. '20.0'")
                  .refine((v) => Number(v) <= 100, "VAT rate cannot exceed 100%")
                  .optional()
                  .describe("VAT rate (e.g. '20.0')"),
              })
            )
            .min(1)
            .max(40)
            .describe("Bill line items — at least one, at most 40"),
          currency: z.string().regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP").optional().describe("ISO 4217 currency (default: company currency)"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Project to allocate this bill to"),
          rebillType: z
            .enum(["cost", "markup", "price"])
            .optional()
            .describe("How to rebill this to the client"),
          rebillFactor: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '15.0'")
            .optional()
            .describe("Markup percentage or fixed price — required for markup/price"),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under 5 MB")
            .optional()
            .describe("Base64-encoded supplier invoice (PDF, PNG, JPEG)"),
          fileName: z.string().optional().describe("File name (e.g. 'invoice.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type. Inferred from fileName if omitted."),
        })
        .strict()
        .refine(
          (a) => Boolean(a.fileBase64) === Boolean(a.fileName),
          "Supply both fileBase64 and fileName, or neither — a lone value would be silently dropped."
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const attachment =
          args.fileBase64 && args.fileName
            ? {
                fileName: args.fileName,
                contentType: args.contentType ?? inferContentType(args.fileName),
                fileBase64: args.fileBase64,
              }
            : undefined;

        const bill = await createBill({
          contactUrl: args.contact,
          reference: args.reference,
          datedOn: args.datedOn,
          dueOn: args.dueOn,
          items: args.items,
          currency: args.currency,
          projectUrl: args.project,
          rebillType: args.rebillType,
          rebillFactor: args.rebillFactor,
          attachment,
        });

        const actions = [`Bill created (${bill.id})`];
        if (attachment) actions.push(`Invoice attached: ${attachment.fileName}`);
        if (args.project) actions.push(`Allocated to project ${args.project}`);

        return ok({
          success: true,
          billId: bill.id,
          billUrl: bill.url,
          reference: bill.reference ?? null,
          dated_on: bill.dated_on,
          due_on: bill.due_on ?? null,
          total_value: bill.total_value,
          due_value: bill.due_value ?? null,
          actions,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_bill",
    {
      description: "Permanently delete a FreeAgent bill.",
      inputSchema: z
        .object({
          billId: z.string().regex(/^\d+$/, "Numeric bill ID").describe("FreeAgent bill ID"),
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
        await deleteBill(args.billId);
        return ok({ success: true, deletedBillId: args.billId });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
