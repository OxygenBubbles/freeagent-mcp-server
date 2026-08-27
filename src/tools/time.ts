import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listTimeslips,
  createTimeslip,
  updateTimeslip,
  deleteTimeslip,
} from "../services/freeagent.js";
import { parseStrictDecimal } from "../utils/money.js";
import { ok, fail, invalid, resourceRegex, dateSchema } from "./respond.js";

const PROJECT_REF = resourceRegex("projects");
const TASK_REF = resourceRegex("tasks");
const USER_REF = resourceRegex("users");

export function registerTimeTools(server: McpServer): void {
  // ── Project tasks ───────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_tasks",
    {
      description:
        "List project tasks in FreeAgent. Time is always logged against a task, " +
        "so use this to find the task URL before creating a timeslip.",
      inputSchema: z
        .object({
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Only tasks belonging to this project"),
          view: z
            .enum(["all", "active", "completed", "hidden"])
            .default("active")
            .describe("Which tasks to return (default: active)"),
          limit: z.number().int().positive().max(100).default(50)
            .describe("Maximum tasks to return (default 50, max 100)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const { items: tasks, mayHaveMore } = await listTasks({
          projectUrl: args.project,
          view: args.view,
          limit: args.limit,
        });
        const rows = tasks.map((t) => ({
          url: t.url,
          id: t.id,
          name: t.name,
          project: t.project,
          is_billable: t.is_billable ?? null,
          billing_rate: t.billing_rate ?? null,
          billing_period: t.billing_period ?? null,
          status: t.status ?? null,
        }));
        return ok({ tasks: rows, count: rows.length, mayHaveMore });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "freeagent_create_task",
    {
      description:
        "Create a task on a FreeAgent project. Tasks carry the billing rate that " +
        "logged time is charged at.",
      inputSchema: z
        .object({
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .describe("Project the task belongs to"),
          name: z.string().min(1).max(200).describe("Task name (e.g. 'Delivery workshops')"),
          isBillable: z.boolean().default(true).describe("Whether time on this task is billable"),
          billingRate: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '850.00'")
            .optional()
            .describe("Rate charged per billing period (e.g. '850.00')"),
          billingPeriod: z
            .enum(["hour", "day"])
            .optional()
            .describe("Whether the billing rate is per hour or per day"),
          currency: z.string().regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP").optional().describe("ISO 4217 currency code"),
          status: z
            .enum(["Active", "Completed", "Hidden"])
            .default("Active")
            .describe("Task status (default Active)"),
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
        const task = await createTask({
          projectUrl: args.project,
          name: args.name,
          isBillable: args.isBillable,
          billingRate: args.billingRate,
          billingPeriod: args.billingPeriod,
          currency: args.currency,
          status: args.status,
        });
        return ok({
          success: true,
          taskId: task.id,
          taskUrl: task.url,
          name: task.name,
          project: task.project,
          is_billable: task.is_billable ?? null,
          billing_rate: task.billing_rate ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Timeslips ───────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_list_timeslips",
    {
      description:
        "List logged time in FreeAgent for a date range. " +
        "Use view='unbilled' to find time that has not yet been invoiced. " +
        "Returns per-project totals alongside the individual entries.",
      inputSchema: z
        .object({
          fromDate: dateSchema("Start of the date range YYYY-MM-DD"),
          toDate: dateSchema("End of the date range YYYY-MM-DD"),
          view: z
            .enum(["all", "unbilled", "running"])
            .default("all")
            .describe("Which timeslips to return (default: all)"),
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .optional()
            .describe("Only time on this project"),
          task: z
            .string()
            .regex(TASK_REF, "Must be a task path like /v2/tasks/123")
            .optional()
            .describe("Only time on this task"),
          user: z
            .string()
            .regex(USER_REF, "Must be a user path like /v2/users/123")
            .optional()
            .describe("Only time logged by this user"),
          limit: z.number().int().positive().max(100).default(100)
            .describe("Maximum timeslips to return (default 100, max 100)"),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const { items: timeslips, mayHaveMore } = await listTimeslips({
          fromDate: args.fromDate,
          toDate: args.toDate,
          view: args.view,
          projectUrl: args.project,
          taskUrl: args.task,
          userUrl: args.user,
          limit: args.limit,
        });
        const rows = timeslips.map((t) => ({
          url: t.url,
          id: t.id,
          dated_on: t.dated_on,
          hours: t.hours,
          project: t.project,
          task: t.task,
          user: t.user,
          comment: t.comment ?? null,
          billed_on_invoice: t.billed_on_invoice ?? null,
        }));

        // Hours are strictly parsed so a malformed value fails rather than
        // silently contributing zero to a billing total.
        const totalHours = rows.reduce(
          (sum, r) => sum + parseStrictDecimal(r.hours, "timeslip hours"),
          0
        );
        const byProject: Record<string, number> = {};
        for (const r of rows) {
          byProject[r.project] =
            (byProject[r.project] ?? 0) + parseStrictDecimal(r.hours, "timeslip hours");
        }

        return ok({
          timeslips: rows,
          count: rows.length,
          totalHours: totalHours.toFixed(2),
          hoursByProject: Object.fromEntries(
            Object.entries(byProject).map(([k, v]) => [k, v.toFixed(2)])
          ),
          mayHaveMore,
          ...(mayHaveMore
            ? { warning: `More timeslips exist beyond the ${args.limit} fetched — the totals above are partial.` }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "freeagent_create_timeslip",
    {
      description:
        "Log time against a FreeAgent project task. " +
        "Defaults to the authenticated user as the person who did the work. " +
        "Find the task with freeagent_list_tasks.",
      inputSchema: z
        .object({
          project: z
            .string()
            .regex(PROJECT_REF, "Must be a project path like /v2/projects/123")
            .describe("Project the work was for"),
          task: z
            .string()
            .regex(TASK_REF, "Must be a task path like /v2/tasks/123")
            .describe("Task the time is logged against"),
          datedOn: dateSchema("Date the work was done YYYY-MM-DD"),
          hours: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '7.5'")
            .describe("Hours worked as a decimal string (e.g. '7.5' for 7h30m)"),
          comment: z.string().max(1000).optional().describe("What the time was spent on"),
          user: z
            .string()
            .regex(USER_REF, "Must be a user path like /v2/users/123")
            .optional()
            .describe("Who did the work (defaults to the authenticated user)"),
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
        const timeslip = await createTimeslip({
          projectUrl: args.project,
          taskUrl: args.task,
          datedOn: args.datedOn,
          hours: args.hours,
          comment: args.comment,
          userUrl: args.user,
        });
        return ok({
          success: true,
          timeslipId: timeslip.id,
          timeslipUrl: timeslip.url,
          dated_on: timeslip.dated_on,
          hours: timeslip.hours,
          project: timeslip.project,
          task: timeslip.task,
          user: timeslip.user,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "freeagent_delete_timeslip",
    {
      description: "Delete a logged timeslip from FreeAgent.",
      inputSchema: z
        .object({
          timeslipId: z
            .string()
            .regex(/^\d+$/, "Numeric timeslip ID")
            .describe("FreeAgent timeslip ID"),
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
        await deleteTimeslip(args.timeslipId);
        return ok({ success: true, deletedTimeslipId: args.timeslipId });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Update task ─────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_task",
    {
      description:
        "Update a FreeAgent project task — rename it, change its billing rate or period, make it " +
        "billable or not, or close it by setting status to 'Completed'. " +
        "A task cannot move between projects. Only the fields you pass are changed.",
      inputSchema: z
        .object({
          taskId: z
            .string()
            .regex(/^\d+$/, "Numeric task ID")
            .describe("Numeric FreeAgent task ID"),
          name: z.string().min(1).max(200).optional().describe("Task name"),
          isBillable: z.boolean().optional().describe("Whether time on this task is billable"),
          billingRate: z
            .string()
            .regex(/^\d+(\.\d{1,2})?$/, "Decimal string, e.g. '650.00'")
            .optional()
            .describe("Rate charged for time on this task"),
          billingPeriod: z
            .enum(["hour", "day"])
            .optional()
            .describe("Whether the billing rate is per hour or per day"),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP")
            .optional()
            .describe("ISO 4217 currency for the billing rate"),
          status: z
            .enum(["Active", "Completed", "Hidden"])
            .optional()
            .describe("Task status"),
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
        const { taskId, ...changes } = args;
        const named = Object.entries(changes).filter(([, v]) => v !== undefined);
        if (named.length === 0) {
          return invalid("Nothing to update — supply at least one field to change.");
        }
        const task = await updateTask(taskId, changes);
        return ok({
          success: true,
          taskId: task.id,
          taskUrl: task.url,
          name: task.name,
          status: task.status ?? null,
          is_billable: task.is_billable ?? null,
          billing_rate: task.billing_rate ?? null,
          changed: named.map(([k]) => k),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Delete task ─────────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_delete_task",
    {
      description:
        "Delete a FreeAgent project task. FreeAgent refuses if time is logged against it — " +
        "set status to 'Completed' or 'Hidden' via freeagent_update_task to retire a task with history.",
      inputSchema: z
        .object({
          taskId: z
            .string()
            .regex(/^\d+$/, "Numeric task ID")
            .describe("Numeric FreeAgent task ID"),
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
        await deleteTask(args.taskId);
        return ok({ success: true, deletedTaskId: args.taskId });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Update timeslip ─────────────────────────────────────────────────────

  server.registerTool(
    "freeagent_update_timeslip",
    {
      description:
        "Correct a logged timeslip — change the hours, the date, the task it sits under, or its comment. " +
        "Only the fields you pass are changed. FreeAgent refuses once the time has been billed on an invoice.",
      inputSchema: z
        .object({
          timeslipId: z
            .string()
            .regex(/^\d+$/, "Numeric timeslip ID")
            .describe("FreeAgent timeslip ID"),
          task: z
            .string()
            .regex(TASK_REF, "Must be a task path like /v2/tasks/123")
            .optional()
            .describe("Move the time to a different task on the same project"),
          datedOn: dateSchema("Date the work was done YYYY-MM-DD").optional(),
          hours: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '7.5'")
            .optional()
            .describe("Corrected hours as a decimal string (e.g. '7.5' for 7h30m)"),
          comment: z.string().max(1000).optional().describe("What the time was spent on"),
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
        const { timeslipId, task, ...rest } = args;
        const named = Object.entries(rest).filter(([, v]) => v !== undefined);
        if (named.length === 0 && !task) {
          return invalid("Nothing to update — supply at least one field to change.");
        }
        const timeslip = await updateTimeslip(timeslipId, {
          ...rest,
          ...(task ? { taskUrl: task } : {}),
        });
        return ok({
          success: true,
          timeslipId: timeslip.id,
          timeslipUrl: timeslip.url,
          dated_on: timeslip.dated_on,
          hours: timeslip.hours,
          task: timeslip.task,
          changed: named.map(([k]) => k).concat(task ? ["task"] : []),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
