import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listContacts,
  createContact,
  updateContact,
  getContact,
  deleteContact,
} from "../services/freeagent.js";
import { ok, fail, invalid } from "./respond.js";

/** Human-readable name for a contact, which may be a person, an org, or both. */
function displayName(c: {
  organisation_name?: string;
  first_name?: string;
  last_name?: string;
}): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
  if (c.organisation_name && person) return `${c.organisation_name} (${person})`;
  return c.organisation_name || person || "(unnamed)";
}

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "freeagent_list_contacts",
    {
      description:
        "List FreeAgent contacts (clients and suppliers). " +
        "Returns contact URL, name, email, status and outstanding account balance. " +
        "Use the contact URL when raising an invoice or entering a supplier bill.",
      inputSchema: z
        .object({
          view: z
            .enum(["all", "active", "clients", "suppliers", "hidden"])
            .default("active")
            .describe("Which contacts to return (default: active)"),
          search: z
            .string()
            .optional()
            .describe("Case-insensitive filter on name or email, applied to the results"),
          limit: z
            .number()
            .int()
            .positive()
            .max(1000)
            .default(100)
            .describe(
              "Maximum contacts to fetch (default 100, max 1000). The server pages " +
              "through as many requests as needed; `search` is applied to everything fetched."
            ),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const { items, mayHaveMore } = await listContacts({
          view: args.view,
          limit: args.limit,
        });
        const needle = args.search?.toLowerCase();
        const rows = items
          .map((c) => ({
            url: c.url,
            id: c.id,
            name: displayName(c),
            organisation_name: c.organisation_name ?? null,
            email: c.email ?? null,
            status: c.status,
            account_balance: c.account_balance ?? null,
            active_projects_count: c.active_projects_count ?? 0,
          }))
          .filter(
            (r) =>
              !needle ||
              r.name.toLowerCase().includes(needle) ||
              (r.email ?? "").toLowerCase().includes(needle)
          );
        return ok({
          contacts: rows,
          count: rows.length,
          // A search that only looked at part of the ledger must say so —
          // otherwise "no match" reads as "does not exist" and a duplicate
          // contact gets created.
          mayHaveMore,
          ...(mayHaveMore
            ? { warning: `More than the ${args.limit} contacts fetched exist; a search may have missed a match. Raise limit (up to 1000) to widen the sweep.` }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "freeagent_create_contact",
    {
      description:
        "Create a contact in FreeAgent — a client to invoice or a supplier to record bills against. " +
        "Supply either an organisation name or a first/last name (or both).",
      inputSchema: z
        .object({
          organisationName: z
            .string()
            .max(200)
            .optional()
            .describe("Company name (e.g. 'Example Client Ltd')"),
          firstName: z.string().max(100).optional().describe("Contact first name"),
          lastName: z.string().max(100).optional().describe("Contact last name"),
          email: z.string().email().optional().describe("Contact email address"),
          phoneNumber: z.string().max(50).optional().describe("Contact phone number"),
          address1: z.string().max(200).optional().describe("First line of the address"),
          address2: z.string().max(200).optional().describe("Second line of the address"),
          town: z.string().max(100).optional().describe("Town or city"),
          region: z.string().max(100).optional().describe("County, region or state"),
          postcode: z.string().max(20).optional().describe("Postcode or ZIP"),
          country: z.string().max(100).optional().describe("Country (e.g. 'United Kingdom')"),
          salesTaxRegistrationNumber: z
            .string()
            .max(50)
            .optional()
            .describe(
              "The contact's VAT registration number (e.g. 'DE123456789'). Required on the invoice " +
              "for a reverse-charge sale, and for the EC Sales List."
            ),
          defaultPaymentTermsInDays: z
            .number()
            .int()
            .min(0)
            .max(365)
            .optional()
            .describe("Default payment terms for this contact's invoices, in days"),
          chargeSalesTax: z
            .enum(["Auto", "Always", "Never"])
            .optional()
            .describe("Whether to charge sales tax to this contact (default: Auto)"),
          contactNameOnInvoices: z
            .boolean()
            .optional()
            .describe("Show the person's name rather than the organisation on invoices"),
          status: z
            .enum(["Active", "Hidden"])
            .optional()
            .describe("Contact status (default Active)"),
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
        if (!args.organisationName && !args.firstName && !args.lastName) {
          return invalid("Supply organisationName, or firstName/lastName, or both.");
        }
        const contact = await createContact(args);
        return ok({
          success: true,
          contactId: contact.id,
          contactUrl: contact.url,
          name: displayName(contact),
          status: contact.status,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Update ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_contact",
    {
      description:
        "Update a FreeAgent contact — correct the name or address, add the VAT registration number " +
        "needed for reverse-charge invoicing, change payment terms, or hide a contact you no longer " +
        "trade with (status='Hidden'). Only the fields you pass are changed.",
      inputSchema: z
        .object({
          contactId: z
            .string()
            .regex(/^\d+$/, "Numeric contact ID")
            .describe("Numeric FreeAgent contact ID"),
          organisationName: z.string().max(200).optional().describe("Company name"),
          firstName: z.string().max(100).optional().describe("Contact first name"),
          lastName: z.string().max(100).optional().describe("Contact last name"),
          email: z.string().email().optional().describe("Contact email address"),
          phoneNumber: z.string().max(50).optional().describe("Contact phone number"),
          address1: z.string().max(200).optional().describe("First line of the address"),
          address2: z.string().max(200).optional().describe("Second line of the address"),
          town: z.string().max(100).optional().describe("Town or city"),
          region: z.string().max(100).optional().describe("County, region or state"),
          postcode: z.string().max(20).optional().describe("Postcode or ZIP"),
          country: z.string().max(100).optional().describe("Country (e.g. 'United Kingdom')"),
          salesTaxRegistrationNumber: z
            .string()
            .max(50)
            .optional()
            .describe("The contact's VAT registration number (e.g. 'DE123456789')"),
          defaultPaymentTermsInDays: z
            .number()
            .int()
            .min(0)
            .max(365)
            .optional()
            .describe("Default payment terms for this contact's invoices, in days"),
          chargeSalesTax: z
            .enum(["Auto", "Always", "Never"])
            .optional()
            .describe("Whether to charge sales tax to this contact"),
          contactNameOnInvoices: z
            .boolean()
            .optional()
            .describe("Show the person's name rather than the organisation on invoices"),
          status: z
            .enum(["Active", "Hidden"])
            .optional()
            .describe("Set to 'Hidden' to retire a contact without deleting it"),
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
        const { contactId, ...changes } = args;
        const named = Object.entries(changes).filter(([, v]) => v !== undefined);
        if (named.length === 0) {
          return invalid("Nothing to update — supply at least one field to change.");
        }
        const contact = await updateContact(contactId, changes);
        return ok({
          success: true,
          contactId: contact.id,
          contactUrl: contact.url,
          name: displayName(contact),
          status: contact.status,
          changed: named.map(([k]) => k),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_contact",
    {
      description:
        "Permanently delete a FreeAgent contact. FreeAgent refuses if anything is filed against them — " +
        "hide the contact instead (freeagent_update_contact with status='Hidden') to retire one with history.",
      inputSchema: z
        .object({
          contactId: z
            .string()
            .regex(/^\d+$/, "Numeric contact ID")
            .describe("Numeric FreeAgent contact ID"),
          confirm: z
            .boolean()
            .describe("Must be true — deleting a contact cannot be undone."),
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
          return invalid("Pass confirm=true to delete the contact — this cannot be undone.");
        }
        // Name it in the result: the record is gone by the time the user reads it.
        const contact = await getContact(args.contactId).catch(() => null);
        await deleteContact(args.contactId);
        return ok({
          success: true,
          deletedContactId: args.contactId,
          name: contact ? displayName(contact) : null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
