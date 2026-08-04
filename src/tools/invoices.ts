import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listInvoices,
  getInvoice,
  createInvoice,
  transitionInvoice,
  deleteInvoice,
} from "../services/freeagent.js";
import { ok, fail, resourceRegex } from "./respond.js";

const CONTACT_REF = resourceRegex("contacts");
const PROJECT_REF = resourceRegex("projects");
const CATEGORY_REF = resourceRegex("categories");

// FreeAgent's permitted invoice line types.
const ITEM_TYPES = [
  "Hours", "Days", "Weeks", "Months", "Years",
  "Products", "Services", "Training", "Expenses",
  "Comment", "Bills", "Discount", "Credit", "VAT", "Stock",
] as const;

export function registerInvoiceTools(server: McpServer): void {
  // ── List ────────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_invoices",
    {
      description:
        "List FreeAgent invoices with their status and outstanding balance. " +
        "Use view='overdue' to chase late payers, 'open_or_overdue' for everything unpaid, " +
        "or 'draft' for invoices not yet issued.",
      inputSchema: z
        .object({
          view: z
            .enum([
              "all", "recent_open_or_overdue", "open", "overdue",
              "open_or_overdue", "draft", "paid",
            ])
            .default("all")
            .describe("Which invoices to return (default: all)"),
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .optional()
            .describe("Only invoices for this contact"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Only invoices for this project"),
          fromDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Earliest invoice date YYYY-MM-DD"),
          toDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Latest invoice date YYYY-MM-DD"),
          limit: z.number().int().positive().max(100).default(50)
            .describe("Maximum invoices to return (default 50, max 100)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const invoices = await listInvoices({
          view: args.view,
          contactUrl: args.contact,
          projectUrl: args.project,
          fromDate: args.fromDate,
          toDate: args.toDate,
          limit: args.limit,
        });
        const rows = invoices.map((i) => ({
          url: i.url,
          id: i.id,
          reference: i.reference ?? null,
          contact: i.contact,
          contact_name: i.contact_name ?? null,
          status: i.status,
          dated_on: i.dated_on,
          due_on: i.due_on ?? null,
          currency: i.currency,
          total_value: i.total_value,
          paid_value: i.paid_value ?? null,
          due_value: i.due_value ?? null,
        }));
        const outstanding = rows.reduce(
          (sum, r) => sum + (parseFloat(r.due_value ?? "0") || 0),
          0
        );
        return ok({
          invoices: rows,
          count: rows.length,
          totalOutstanding: outstanding.toFixed(2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Get one, with line items ────────────────────────────────────────────

  server.registerTool(
    "freeagent_get_invoice",
    {
      description:
        "Fetch a single FreeAgent invoice in full, including its line items.",
      inputSchema: z
        .object({
          invoiceId: z
            .string()
            .regex(/^\d+$/, "Numeric invoice ID, e.g. '12345678'")
            .describe("FreeAgent invoice ID"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const invoice = await getInvoice(args.invoiceId);
        return ok({
          url: invoice.url,
          id: invoice.id,
          reference: invoice.reference ?? null,
          contact: invoice.contact,
          contact_name: invoice.contact_name ?? null,
          status: invoice.status,
          long_status: invoice.long_status ?? null,
          dated_on: invoice.dated_on,
          due_on: invoice.due_on ?? null,
          paid_on: invoice.paid_on ?? null,
          currency: invoice.currency,
          net_value: invoice.net_value,
          sales_tax_value: invoice.sales_tax_value ?? null,
          total_value: invoice.total_value,
          due_value: invoice.due_value ?? null,
          payment_terms_in_days: invoice.payment_terms_in_days ?? null,
          project: invoice.project ?? null,
          po_reference: invoice.po_reference ?? null,
          comments: invoice.comments ?? null,
          items: (invoice.invoice_items ?? []).map((it) => ({
            description: it.description,
            item_type: it.item_type,
            price: it.price,
            quantity: it.quantity,
            sales_tax_rate: it.sales_tax_rate ?? null,
            category: it.category ?? null,
          })),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Create ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_create_invoice",
    {
      description:
        "Raise an invoice in FreeAgent. Created as a DRAFT — it is not sent to the client. " +
        "Use freeagent_update_invoice_status with 'mark_as_sent' once you have issued it.\n\n" +
        "Find the contact with freeagent_list_contacts and the income category with " +
        "freeagent_list_categories (income categories, e.g. 001 Sales).",
      inputSchema: z
        .object({
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .describe("Contact to invoice"),
          datedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Invoice date YYYY-MM-DD"),
          paymentTermsInDays: z
            .number()
            .int()
            .min(0)
            .max(365)
            .default(30)
            .describe("Payment terms in days (default 30) — sets the due date"),
          items: z
            .array(
              z.object({
                description: z.string().min(1).max(2000).describe("Line description"),
                itemType: z
                  .enum(ITEM_TYPES)
                  .default("Services")
                  .describe("Line type (default Services)"),
                price: z
                  .string()
                  .regex(/^-?\d+(\.\d+)?$/, "Numeric string, e.g. '750.00'")
                  .describe("Unit price as a string (e.g. '750.00')"),
                quantity: z
                  .string()
                  .regex(/^-?\d+(\.\d+)?$/, "Numeric string, e.g. '1.0'")
                  .default("1.0")
                  .describe("Quantity (e.g. '1.0', or hours/days for time-based types)"),
                salesTaxRate: z
                  .string()
                  .optional()
                  .describe("VAT rate as a string (e.g. '20.0')"),
                categoryUrl: z
                  .string()
                  .regex(CATEGORY_REF, "Must be a category path like /v2/categories/001")
                  .optional()
                  .describe("Income category (e.g. '/v2/categories/001' for Sales)"),
              })
            )
            .min(1)
            .max(40)
            .describe("Invoice line items — at least one"),
          reference: z
            .string()
            .max(100)
            .optional()
            .describe("Invoice reference/number. FreeAgent auto-numbers if omitted."),
          currency: z.string().length(3).optional().describe("ISO 4217 currency (default: company currency)"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Project this invoice belongs to"),
          poReference: z.string().max(100).optional().describe("Client purchase order reference"),
          comments: z.string().max(2000).optional().describe("Notes shown on the invoice"),
          discountPercent: z.string().optional().describe("Discount percentage (e.g. '10.0')"),
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
        const invoice = await createInvoice({
          contactUrl: args.contact,
          datedOn: args.datedOn,
          paymentTermsInDays: args.paymentTermsInDays,
          items: args.items,
          reference: args.reference,
          currency: args.currency,
          projectUrl: args.project,
          poReference: args.poReference,
          comments: args.comments,
          discountPercent: args.discountPercent,
        });
        return ok({
          success: true,
          invoiceId: invoice.id,
          invoiceUrl: invoice.url,
          reference: invoice.reference ?? null,
          status: invoice.status,
          dated_on: invoice.dated_on,
          due_on: invoice.due_on ?? null,
          net_value: invoice.net_value,
          sales_tax_value: invoice.sales_tax_value ?? null,
          total_value: invoice.total_value,
          note: "Created as a draft. It has not been sent to the client.",
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Status transitions ──────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_invoice_status",
    {
      description:
        "Change an invoice's status in FreeAgent: mark_as_sent (issue it), mark_as_draft " +
        "(pull it back), mark_as_scheduled, or mark_as_cancelled. " +
        "These change status only — no email is sent to the client.",
      inputSchema: z
        .object({
          invoiceId: z
            .string()
            .regex(/^\d+$/, "Numeric invoice ID")
            .describe("FreeAgent invoice ID"),
          transition: z
            .enum(["mark_as_sent", "mark_as_draft", "mark_as_scheduled", "mark_as_cancelled"])
            .describe("The status change to apply"),
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
        const invoice = await transitionInvoice(args.invoiceId, args.transition);
        return ok({
          success: true,
          invoiceId: invoice.id,
          invoiceUrl: invoice.url,
          status: invoice.status,
          long_status: invoice.long_status ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_invoice",
    {
      description:
        "Permanently delete a FreeAgent invoice. Only draft invoices can normally be deleted — " +
        "cancel an issued invoice instead with freeagent_update_invoice_status.",
      inputSchema: z
        .object({
          invoiceId: z
            .string()
            .regex(/^\d+$/, "Numeric invoice ID")
            .describe("FreeAgent invoice ID"),
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
        await deleteInvoice(args.invoiceId);
        return ok({ success: true, deletedInvoiceId: args.invoiceId });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
