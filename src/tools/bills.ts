import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listBills,
  createBill,
  updateBill,
  getBill,
  deleteBill,
  replaceAttachment,
} from "../services/freeagent.js";
import { sumResponseMoney } from "../utils/money.js";
import {
  checkAttachmentSource,
  resolveAttachmentSource,
} from "../utils/attachmentSource.js";
import { ok, fail, invalid, resourceRegex, dateSchema } from "./respond.js";

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
        const { total: outstanding, missing: missingDueValues } = sumResponseMoney(
          rows.map((r) => r.due_value),
          "bill due value"
        );
        return ok({
          bills: rows,
          count: rows.length,
          totalOutstandingForReturned: outstanding,
          // Records whose outstanding value was absent are excluded from the
          // total above and counted here, rather than silently read as zero.
          missingDueValues,
          // Retained under the old name so an existing consumer keeps working;
          // prefer the explicit one, which says what it actually covers.
          totalOutstanding: outstanding,
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

  // ── Get one ─────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_get_bill",
    {
      description:
        "Fetch one FreeAgent bill in full, including its line items and each line's own URL. " +
        "Read this before freeagent_update_bill when editing or removing existing lines — " +
        "the line URLs are what address them.",
      inputSchema: z
        .object({
          billId: z
            .string()
            .regex(/^\d+$/, "Numeric bill ID")
            .describe("FreeAgent bill ID"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const bill = await getBill(args.billId);
        return ok({
          billId: bill.id,
          billUrl: bill.url,
          contact: bill.contact,
          reference: bill.reference ?? null,
          status: bill.status ?? null,
          dated_on: bill.dated_on,
          due_on: bill.due_on ?? null,
          paid_on: bill.paid_on ?? null,
          currency: bill.currency ?? null,
          total_value: bill.total_value,
          paid_value: bill.paid_value ?? null,
          due_value: bill.due_value ?? null,
          project: bill.project ?? null,
          items: (bill.bill_items ?? []).map((it) => ({
            // The line's own URL is what freeagent_update_bill needs to edit
            // or remove it — without it, existing lines are unaddressable.
            itemUrl: it.url ?? null,
            category: it.category,
            description: it.description ?? null,
            total_value: it.total_value,
            sales_tax_rate: it.sales_tax_rate ?? null,
          })),
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
        "(Gmail, Outlook/M365) for the supplier invoice. PREFER filePath (a local file) or fileUrl (a download link) — " +
        "the server reads and encodes it; large inline fileBase64 is unreliable.",
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
                salesTaxStatus: z
                  .enum(["TAXABLE", "EXEMPT", "OUT_OF_SCOPE"])
                  .optional()
                  .describe("Tax status of the line (default TAXABLE)"),
                quantity: z.string().optional().describe("Quantity (default 1)"),
                unit: z
                  .string()
                  .max(50)
                  .optional()
                  .describe("Unit, e.g. 'Hours', 'Days', 'Products'"),
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
          ecStatus: z
            .enum(["UK/Non-EC", "EC Goods", "EC Services", "Reverse Charge"])
            .optional()
            .describe(
              "VAT treatment for the purchase. Defaults to 'UK/Non-EC' — set it for an overseas " +
              "supplier or a reverse-charge purchase, or the VAT return reports it in the wrong box."
            ),
          comments: z.string().max(2000).optional().describe("Free-text notes on the bill"),
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
            .describe(
              "Base64-encoded supplier invoice (PDF, PNG, JPEG). LAST RESORT — " +
              "unreliable above a few hundred KB; prefer filePath or fileUrl."
            ),
          fileName: z.string().optional().describe("File name (e.g. 'invoice.pdf')"),
          contentType: z
            .string()
            .optional()
            .describe("MIME type. Inferred from the file name if omitted."),
          filePath: z
            .string()
            .optional()
            .describe(
              "Absolute path to a local invoice file. The SERVER reads and base64-encodes it — " +
              "PREFER THIS over fileBase64. fileName defaults to the file's name."
            ),
          fileUrl: z
            .string()
            .url()
            .optional()
            .describe("URL of a supplier invoice to download and attach. The server fetches and encodes it."),
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

        if (args.rebillType && !args.project) {
          return invalid(
            "rebillType needs a project — FreeAgent rebills a bill to the project it is allocated to."
          );
        }
        if (args.rebillFactor && !args.rebillType) {
          return invalid(
            "rebillFactor does nothing without rebillType — say whether it is a markup or a fixed price."
          );
        }

        const attachment = await resolveAttachmentSource(args, {
          maxBase64: FILE_BASE64_MAX,
          sizeLabel: "5 MB",
        });

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
          ecStatus: args.ecStatus,
          comments: args.comments,
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


  // ── Update ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_bill",
    {
      description:
        "Update a FreeAgent bill — correct the reference, dates or VAT status, allocate it to a project, " +
        "set the rebill treatment, attach or replace the supplier invoice, or edit its line items.\n\n" +
        "Only the fields you pass are changed. Line items are addressed by their own URL: a line with no " +
        "itemUrl is ADDED, a line with itemUrl is edited, and destroy=true removes it. " +
        "Omit items entirely to leave the existing lines alone — read them from freeagent_get_bill first, " +
        "which returns each line's itemUrl.",
      inputSchema: z
        .object({
          billId: z
            .string()
            .regex(/^\d+$/, "Numeric bill ID")
            .describe("FreeAgent bill ID"),
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .optional()
            .describe("Move the bill to a different supplier"),
          reference: z.string().max(100).optional().describe("Supplier's invoice reference"),
          datedOn: dateSchema("Bill date YYYY-MM-DD").optional(),
          dueOn: dateSchema("Payment due date YYYY-MM-DD").optional(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP")
            .optional()
            .describe("ISO 4217 currency"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Project to allocate this bill to"),
          ecStatus: z
            .enum(["UK/Non-EC", "EC Goods", "EC Services", "Reverse Charge"])
            .optional()
            .describe("VAT treatment for the purchase"),
          comments: z.string().max(2000).optional().describe("Free-text notes on the bill"),
          rebillType: z
            .enum(["cost", "markup", "price"])
            .optional()
            .describe("How to rebill this to the client — needs the bill to be on a project"),
          rebillFactor: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '15.0'")
            .optional()
            .describe("Markup percentage or fixed price — required for markup/price"),
          items: z
            .array(
              z.object({
                itemUrl: z
                  .string()
                  .regex(
                    /^(?:https:\/\/api\.freeagent\.com)?\/v2\/bill_items\/\d+$/,
                    "Must be a bill item path like /v2/bill_items/123"
                  )
                  .optional()
                  .describe("URL of an existing line to edit or remove. Omit to add a new line."),
                destroy: z
                  .boolean()
                  .optional()
                  .describe("Set true with itemUrl to delete that line"),
                categoryUrl: z
                  .string()
                  .regex(CATEGORY_REF, "Must be a category path like /v2/categories/285")
                  .optional()
                  .describe("Category for the line (required on a new line)"),
                totalValue: z
                  .string()
                  .regex(/^\d+(\.\d{1,2})?$/, "Positive amount, e.g. '120.00'")
                  .optional()
                  .describe("Line total including tax (required on a new line)"),
                description: z.string().max(1000).optional().describe("Line description"),
                salesTaxRate: z
                  .string()
                  .regex(/^\d+(\.\d+)?$/, "Percentage, e.g. '20.0'")
                  .optional()
                  .describe("VAT rate (e.g. '20.0')"),
                salesTaxStatus: z
                  .enum(["TAXABLE", "EXEMPT", "OUT_OF_SCOPE"])
                  .optional()
                  .describe("Tax status of the line"),
                quantity: z.string().optional().describe("Quantity (default 1)"),
                unit: z.string().max(50).optional().describe("Unit, e.g. 'Hours', 'Days', 'Products'"),
              })
            )
            .max(40)
            .optional()
            .describe("Line items to add, edit or remove — see the description for the rules"),
          fileBase64: z
            .string()
            .max(FILE_BASE64_MAX, "File must be under 5 MB")
            .optional()
            .describe("Base64-encoded supplier invoice. LAST RESORT — prefer filePath or fileUrl."),
          fileName: z.string().optional().describe("File name (e.g. 'invoice.pdf')"),
          contentType: z.string().optional().describe("MIME type. Inferred from the file name if omitted."),
          filePath: z
            .string()
            .optional()
            .describe("Absolute path to a local invoice file. The SERVER reads and encodes it."),
          fileUrl: z
            .string()
            .url()
            .optional()
            .describe("URL of a supplier invoice to download and attach."),
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

        if (
          (args.rebillType === "markup" || args.rebillType === "price") &&
          !args.rebillFactor
        ) {
          return invalid(
            `rebillType '${args.rebillType}' needs rebillFactor (the markup percentage or fixed price).`
          );
        }
        if (args.rebillFactor && !args.rebillType) {
          return invalid(
            "rebillFactor does nothing without rebillType — say whether it is a markup or a fixed price."
          );
        }
        // Rebilling only means anything against a project. The bill may already
        // be on one, so check FreeAgent rather than demand it again.
        if (args.rebillType && !args.project) {
          const current = await getBill(args.billId);
          if (!current.project) {
            return invalid(
              "rebillType needs a project — this bill is not allocated to one. Pass project as well."
            );
          }
        }

        const actions: string[] = [];

        // The attachment goes on first: a rejected file then fails the call
        // before the field changes land, instead of half-applying.
        const attachment = await resolveAttachmentSource(args, {
          maxBase64: FILE_BASE64_MAX,
          sizeLabel: "5 MB",
        });
        if (attachment) {
          const { attachment: att, replaced } = await replaceAttachment({
            entityId: args.billId,
            entityType: "bill",
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            fileBase64: attachment.fileBase64,
          });
          actions.push(
            `Attached ${att.file_name} (${att.file_size} bytes)${replaced ? " (replaced previous)" : ""}`
          );
        }

        const changes = {
          contactUrl: args.contact,
          reference: args.reference,
          datedOn: args.datedOn,
          dueOn: args.dueOn,
          currency: args.currency,
          projectUrl: args.project,
          rebillType: args.rebillType,
          rebillFactor: args.rebillFactor,
          ecStatus: args.ecStatus,
          comments: args.comments,
          items: args.items,
        };
        const named = Object.entries(changes).filter(([, v]) => v !== undefined);

        if (named.length === 0 && !attachment) {
          return invalid(
            "Nothing to update — supply a field to change or an invoice to attach."
          );
        }

        let bill = await getBill(args.billId);
        if (named.length > 0) {
          bill = await updateBill(args.billId, changes);
          for (const [key] of named) {
            if (key === "items") {
              const added = args.items!.filter((i) => !i.itemUrl).length;
              const removed = args.items!.filter((i) => i.destroy).length;
              const edited = args.items!.length - added - removed;
              actions.push(
                `Line items: ${added} added, ${edited} edited, ${removed} removed`
              );
            } else {
              actions.push(`${key} updated`);
            }
          }
        }

        return ok({
          success: true,
          billId: bill.id,
          billUrl: bill.url,
          reference: bill.reference ?? null,
          dated_on: bill.dated_on,
          due_on: bill.due_on ?? null,
          total_value: bill.total_value,
          due_value: bill.due_value ?? null,
          project: bill.project ?? null,
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
