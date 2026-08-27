import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from "../services/freeagent.js";
import { ok, fail, invalid, resourceRegex, dateSchema } from "./respond.js";

const CONTACT_REF = resourceRegex("contacts");

/** Fields shared by create and update, so the two schemas cannot drift. */
const PROJECT_FIELDS = {
  name: z.string().min(1).max(200).describe("Project name (e.g. 'Example Client Ltd — Q3 build')"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP")
    .describe("ISO 4217 currency code (default GBP)"),
  budget: z.number().min(0).describe("Budget figure, in the units given by budgetUnits (default 0 — no budget)"),
  budgetUnits: z
    .enum(["Hours", "Days", "Monetary"])
    .describe("What the budget counts — Hours, Days or Monetary (ex-VAT). Default Hours."),
  status: z
    .enum(["Active", "Completed", "Cancelled", "Hidden"])
    .describe("Project status (default Active)"),
  normalBillingRate: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "Decimal string, e.g. '650.00'")
    .describe("Standard billing rate for time on this project"),
  billingPeriod: z.enum(["hour", "day"]).describe("Whether the billing rate is per hour or per day"),
  hoursPerDay: z.number().positive().max(24).describe("Hours in a working day, for day-rate billing"),
  contractPoReference: z.string().max(100).describe("Client contract or purchase order reference"),
  isIr35: z.boolean().describe("Whether the engagement is inside IR35"),
  usesProjectInvoiceSequence: z
    .boolean()
    .describe("Number this project's invoices in their own sequence rather than the company-wide one"),
  includeUnbilledTimeInProfitability: z
    .boolean()
    .describe("Count unbilled time towards the project's profitability figures"),
};

export function registerProjectTools(server: McpServer): void {
  // ── List ────────────────────────────────────────────────────────────────

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
        const { items, mayHaveMore } = await listProjects(args.view);
        const rows = items.map((p) => ({
          url: p.url,
          id: p.id,
          name: p.name,
          status: p.status,
          contact: p.contact ?? null,
          currency: p.currency ?? null,
        }));
        return ok({ projects: rows, count: rows.length, mayHaveMore });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Create ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_create_project",
    {
      description:
        "Create a FreeAgent project against a client contact. " +
        "A project is what expenses, bills and time are tagged to, and what rebilling bills on to. " +
        "Only contact and name are needed — currency defaults to GBP, budget to zero and status to Active.",
      inputSchema: z
        .object({
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .describe("FreeAgent contact URL for the client. Use freeagent_list_contacts to find it."),
          name: PROJECT_FIELDS.name,
          currency: PROJECT_FIELDS.currency.default("GBP"),
          budget: PROJECT_FIELDS.budget.optional(),
          budgetUnits: PROJECT_FIELDS.budgetUnits.optional(),
          status: PROJECT_FIELDS.status.optional(),
          normalBillingRate: PROJECT_FIELDS.normalBillingRate.optional(),
          billingPeriod: PROJECT_FIELDS.billingPeriod.optional(),
          hoursPerDay: PROJECT_FIELDS.hoursPerDay.optional(),
          contractPoReference: PROJECT_FIELDS.contractPoReference.optional(),
          startsOn: dateSchema("Project start date YYYY-MM-DD").optional(),
          endsOn: dateSchema("Project end date YYYY-MM-DD").optional(),
          isIr35: PROJECT_FIELDS.isIr35.optional(),
          usesProjectInvoiceSequence: PROJECT_FIELDS.usesProjectInvoiceSequence.optional(),
          includeUnbilledTimeInProfitability:
            PROJECT_FIELDS.includeUnbilledTimeInProfitability.optional(),
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
        const project = await createProject({ ...args, contactUrl: args.contact });
        return ok({
          success: true,
          projectId: project.id,
          projectUrl: project.url,
          name: project.name,
          status: project.status,
          currency: project.currency ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Update ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_project",
    {
      description:
        "Update a FreeAgent project — rename it, change its budget or billing rate, move it to a " +
        "different client, or close it by setting status to Completed. " +
        "Only the fields you pass are changed; everything else is left alone.",
      inputSchema: z
        .object({
          projectId: z
            .string()
            .regex(/^\d+$/, "Numeric FreeAgent project ID")
            .describe("Numeric FreeAgent project ID"),
          contact: z
            .string()
            .regex(CONTACT_REF, "Must be a contact path like /v2/contacts/123")
            .optional()
            .describe("Move the project to a different client contact"),
          name: PROJECT_FIELDS.name.optional(),
          currency: PROJECT_FIELDS.currency.optional(),
          budget: PROJECT_FIELDS.budget.optional(),
          budgetUnits: PROJECT_FIELDS.budgetUnits.optional(),
          status: PROJECT_FIELDS.status.optional(),
          normalBillingRate: PROJECT_FIELDS.normalBillingRate.optional(),
          billingPeriod: PROJECT_FIELDS.billingPeriod.optional(),
          hoursPerDay: PROJECT_FIELDS.hoursPerDay.optional(),
          contractPoReference: PROJECT_FIELDS.contractPoReference.optional(),
          startsOn: dateSchema("Project start date YYYY-MM-DD").optional(),
          endsOn: dateSchema("Project end date YYYY-MM-DD").optional(),
          isIr35: PROJECT_FIELDS.isIr35.optional(),
          usesProjectInvoiceSequence: PROJECT_FIELDS.usesProjectInvoiceSequence.optional(),
          includeUnbilledTimeInProfitability:
            PROJECT_FIELDS.includeUnbilledTimeInProfitability.optional(),
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
        const { projectId, contact, ...rest } = args;
        const project = await updateProject(projectId, {
          ...rest,
          ...(contact ? { contactUrl: contact } : {}),
        });
        return ok({
          success: true,
          projectId: project.id,
          projectUrl: project.url,
          name: project.name,
          status: project.status,
          changed: Object.keys(rest).concat(contact ? ["contact"] : []),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete ──────────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_project",
    {
      description:
        "Permanently delete a FreeAgent project. FreeAgent refuses if anything is booked against it — " +
        "set status to 'Completed' or 'Hidden' via freeagent_update_project to retire a project that has history.",
      inputSchema: z
        .object({
          projectId: z
            .string()
            .regex(/^\d+$/, "Numeric FreeAgent project ID")
            .describe("Numeric FreeAgent project ID"),
          confirm: z
            .boolean()
            .describe("Must be true — deleting a project cannot be undone."),
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
          return invalid("Pass confirm=true to delete the project — this cannot be undone.");
        }
        // Name it in the result: "deleted project 123" is not something the
        // user can check afterwards, and the record is gone by then.
        const project = await getProject(args.projectId).catch(() => null);
        await deleteProject(args.projectId);
        return ok({
          success: true,
          deletedProjectId: args.projectId,
          name: project?.name ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
