#!/usr/bin/env node
/**
 * FreeAgent MCP Server
 *
 * Tools for FreeAgent bookkeeping:
 *  - List bank accounts and transactions
 *  - Explain transactions (categorise, describe, attach receipt, approve)
 *  - Create expenses from receipts (personal card / cash claims)
 *  - Create mileage expenses
 *  - List expense categories and projects
 *  - Manage contacts (clients and suppliers)
 *  - Raise, issue and track invoices; chase overdue payers
 *  - Record supplier bills (accounts payable)
 *  - Log time against project tasks
 *  - Report: profit and loss, trial balance, aged debtors/creditors, tax timeline
 *
 * Email/receipt search is NOT built in — use your own email MCP
 * (Outlook, Gmail, etc.) alongside this server.
 *
 * Transport: stdio (default) or HTTP (set PORT env var)
 *
 * Required:
 *   FREEAGENT_CLIENT_ID       – FreeAgent OAuth app client ID
 *   FREEAGENT_CLIENT_SECRET   – FreeAgent OAuth app client secret
 *   FREEAGENT_REFRESH_TOKEN   – Long-lived OAuth refresh token
 *
 * Optional:
 *   VENDOR_CATEGORIES         – JSON: vendor name → FreeAgent category URL
 *   MILEAGE_RATE_PENCE        – Flat pence-per-mile rate (overrides HMRC rates)
 *   MILEAGE_CATEGORY_URL      – FreeAgent category URL for mileage
 *   HMRC_RATE_HIGH_PENCE      – HMRC high rate in pence (default 45)
 *   HMRC_RATE_LOW_PENCE       – HMRC low rate in pence (default 25)
 *   HMRC_THRESHOLD_MILES      – HMRC threshold miles per tax year (default 10000)
 *   ORS_API_KEY               – OpenRouteService key (mileage distance calc)
 *   GOOGLE_MAPS_API_KEY       – Google Maps key (alternative to ORS)
 *   PORT                      – HTTP mode port (e.g. 3000)
 *   AUTH_TOKEN                – Bearer token required in HTTP mode (recommended)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "crypto";
import { registerAccountTools } from "./tools/accounts.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerMileageTools } from "./tools/mileage.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerBillTools } from "./tools/bills.js";
import { registerTimeTools } from "./tools/time.js";
import { registerReportTools } from "./tools/reports.js";

// ── CLI subcommand dispatch ──────────────────────────────────────────────────
// `freeagent-mcp-server auth` runs the OAuth setup flow. Any other invocation
// starts the MCP server as normal.
if (process.argv[2] === "auth") {
  const { runAuth } = await import("./auth.js");
  try {
    await runAuth();
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nError: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

const server = new McpServer(
  {
    name: "freeagent-mcp-server",
    version: "3.0.1",
  },
  {
    instructions: `
You are connected to a FreeAgent accounting server. Use these tools to manage bank transactions, expenses, and mileage for the user's FreeAgent account.

## Receipt and invoice sourcing

When a task involves attaching a receipt or invoice to a transaction or expense, do NOT ask the user to provide the file manually unless you have already exhausted all available sources. Instead, proactively search for it using whatever tools you have access to in this session. Common sources to try (in order):

1. **Email** — search all connected email accounts (Gmail, Outlook/M365, or any other mail MCP) for a matching invoice or receipt. Use the vendor name, amount, and date as search terms. Download the PDF attachment or invoice link from the matching email.
2. **Local files** — if the user mentions files are saved locally (e.g. Downloads folder), read them directly.
3. **URLs** — if an invoice URL is visible in an email or document, fetch the PDF from it.

Only ask the user to provide a file if none of these sources yield a match.

## Reconciliation workflow

When asked to reconcile transactions or "process" unexplained items:
1. Call \`freeagent_list_transactions\` with \`view: "marked_for_review"\` or \`"unexplained"\` to get outstanding items.
2. For each transaction, search available email/file sources for a matching receipt.
3. When found, call \`freeagent_explain_transaction\` with \`fileBase64\`, \`markExplained: true\`, and a clear description.
4. Report what was approved, what was skipped (no receipt found), and what needs manual review.

## Invoicing

Invoices are always created as DRAFTS. Creating one does not send anything to the client.
1. Find the client with \`freeagent_list_contacts\` (or create one with \`freeagent_create_contact\`).
2. Find the income category with \`freeagent_list_categories\` — income categories such as 001 Sales.
3. Call \`freeagent_create_invoice\` with one or more line items.
4. Only after the user confirms, call \`freeagent_update_invoice_status\` with \`mark_as_sent\`.

To chase payment, call \`freeagent_list_invoices\` with \`view: "overdue"\`, or \`freeagent_aged_debtors\` for a bucketed view of who owes what and for how long.

## Money owed and financial position

- \`freeagent_aged_debtors\` — unpaid customer invoices by age
- \`freeagent_aged_creditors\` — unpaid supplier bills by age
- \`freeagent_profit_and_loss\` — income, expenses, profit for a period
- \`freeagent_trial_balance\` — every nominal account balance
- \`freeagent_tax_timeline\` — upcoming VAT, corporation tax and filing deadlines

## Time tracking

Time is logged against a project TASK, never a project directly. Use \`freeagent_list_tasks\` to find the task first; create one with \`freeagent_create_task\` if none exists. \`freeagent_list_timeslips\` with \`view: "unbilled"\` shows work done but not yet invoiced.

## Safety

Never set \`markExplained: true\` without a confirmed receipt or explicit user instruction. Transactions skipped due to missing receipts should be reported to the user for manual follow-up.

Confirm with the user before issuing an invoice (\`mark_as_sent\`), deleting anything, or recording a bill — these affect the company's real financial records.
    `.trim(),
  }
);

registerAccountTools(server);
registerTransactionTools(server);
registerExpenseTools(server);
registerMileageTools(server);
registerContactTools(server);
registerInvoiceTools(server);
registerBillTools(server);
registerTimeTools(server);
registerReportTools(server);

async function main(): Promise<void> {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  if (port) {
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const http = await import("http");

    const authToken = process.env.AUTH_TOKEN;
    if (!authToken) {
      process.stderr.write(
        "Warning: AUTH_TOKEN is not set. HTTP mode is unauthenticated — set AUTH_TOKEN to require a bearer token.\n"
      );
    }

    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
    });

    const httpServer = http.createServer(async (req, res) => {
      if (authToken) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }
      await httpTransport.handleRequest(req, res);
    });

    await server.connect(httpTransport);

    httpServer.listen(port, () => {
      process.stderr.write(
        `FreeAgent MCP server listening on http://localhost:${port}${authToken ? " (authenticated)" : " (WARNING: no AUTH_TOKEN)"}\n`
      );
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("FreeAgent MCP server running on stdio\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
