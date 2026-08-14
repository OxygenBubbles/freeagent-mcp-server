/**
 * Every tool must advertise its parameters.
 *
 * Regression: object-level `.refine()` turns a ZodObject into a ZodEffects.
 * The MCP SDK cannot read `.shape` from that, so it emitted an inputSchema with
 * NO properties. The tools still worked if a caller happened to send the right
 * arguments, but a real client reads the advertised schema — saw no parameters,
 * sent none, and every call failed with the arguments apparently "dropped".
 *
 * It shipped in 3.0.0 and broke create_expense, create_contact, create_bill and
 * explain_transaction, because the end-to-end tests passed hardcoded arguments
 * instead of driving the tools from their advertised schema.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAccountTools } from "../../tools/accounts.js";
import { registerTransactionTools } from "../../tools/transactions.js";
import { registerExpenseTools } from "../../tools/expenses.js";
import { registerMileageTools } from "../../tools/mileage.js";
import { registerContactTools } from "../../tools/contacts.js";
import { registerInvoiceTools } from "../../tools/invoices.js";
import { registerBillTools } from "../../tools/bills.js";
import { registerTimeTools } from "../../tools/time.js";
import { registerReportTools } from "../../tools/reports.js";

/** The only tools that legitimately take no arguments at all. */
const PARAMETERLESS = new Set([
  "freeagent_list_bank_accounts",
  "freeagent_list_categories",
  "freeagent_company_summary",
]);

/** Parameters a caller cannot do without, by tool. */
const REQUIRED_PARAMS: Record<string, string[]> = {
  freeagent_list_transactions: ["bankAccountId"],
  freeagent_explain_transaction: ["explanationId", "category", "fileUrl", "markExplained"],
  freeagent_create_expense: ["vendor", "datedOn", "grossAmount", "description"],
  freeagent_create_contact: ["organisationName", "firstName", "email"],
  freeagent_create_invoice: ["contact", "datedOn", "items"],
  freeagent_create_bill: ["contact", "reference", "datedOn", "dueOn", "items"],
  freeagent_create_timeslip: ["project", "task", "datedOn", "hours"],
  freeagent_create_task: ["project", "name"],
  freeagent_get_invoice: ["invoiceId"],
  freeagent_update_invoice_status: ["invoiceId", "transition"],
  freeagent_delete_invoice: ["invoiceId"],
  freeagent_delete_bill: ["billId"],
  freeagent_delete_timeslip: ["timeslipId"],
  freeagent_create_mileage_expense: ["datedOn", "description"],
};

let tools: Array<{ name: string; inputSchema?: unknown }> = [];

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAccountTools(server);
  registerTransactionTools(server);
  registerExpenseTools(server);
  registerMileageTools(server);
  registerContactTools(server);
  registerInvoiceTools(server);
  registerBillTools(server);
  registerTimeTools(server);
  registerReportTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  tools = (await client.listTools()).tools as typeof tools;
});

function propsOf(tool: { inputSchema?: unknown }): string[] {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
}

describe("advertised tool schemas", () => {
  it("registers every tool", () => {
    expect(tools.length).toBeGreaterThanOrEqual(28);
  });

  it("advertises properties for every tool that takes arguments", () => {
    const broken = tools
      .filter((t) => !PARAMETERLESS.has(t.name) && propsOf(t).length === 0)
      .map((t) => t.name);
    // A tool here is invisible to clients: they read this schema to decide what
    // to send, so an empty one means every call arrives with no arguments.
    expect(broken).toEqual([]);
  });

  it("exposes the parameters callers actually need", () => {
    for (const [name, required] of Object.entries(REQUIRED_PARAMS)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeDefined();
      const props = propsOf(tool!);
      for (const param of required) {
        expect(props, `${name} must advertise "${param}"`).toContain(param);
      }
    }
  });

  it("keeps every inputSchema a plain object schema", () => {
    for (const tool of tools) {
      const schema = (tool.inputSchema ?? {}) as { type?: string };
      expect(schema.type, `${tool.name}`).toBe("object");
    }
  });
});
