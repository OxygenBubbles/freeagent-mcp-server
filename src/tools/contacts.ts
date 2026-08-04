import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listContacts, createContact } from "../services/freeagent.js";
import { ok, fail } from "./respond.js";

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
            .max(100)
            .default(50)
            .describe("Maximum contacts to return (default 50, max 100)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const contacts = await listContacts({ view: args.view, limit: args.limit });
        const needle = args.search?.toLowerCase();
        const rows = contacts
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
        return ok({ contacts: rows, count: rows.length });
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
          chargeSalesTax: z
            .enum(["Auto", "Always", "Never"])
            .optional()
            .describe("Whether to charge sales tax to this contact (default: Auto)"),
          contactNameOnInvoices: z
            .boolean()
            .optional()
            .describe("Show the person's name rather than the organisation on invoices"),
        })
        .strict()
        .refine(
          (a) => Boolean(a.organisationName || a.firstName || a.lastName),
          "Supply organisationName, or firstName/lastName, or both."
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
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
}
