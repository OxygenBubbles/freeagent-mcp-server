#!/usr/bin/env node
/**
 * FreeAgent MCP Server
 *
 * Tools for FreeAgent bookkeeping:
 *  - List bank accounts and transactions
 *  - Explain transactions (categorise, describe, attach receipt, approve)
 *  - Create expenses from receipts (personal card / cash claims)
 *  - Create mileage expenses with configurable rates
 *  - List expense categories
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
 *   MILEAGE_RATE_PENCE        – Default pence-per-mile rate
 *   MILEAGE_CATEGORY_URL      – FreeAgent category URL for mileage
 *   ORS_API_KEY               – OpenRouteService key (mileage distance calc)
 *   GOOGLE_MAPS_API_KEY       – Google Maps key (alternative to ORS)
 *   PORT                      – HTTP mode port (e.g. 3000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerMileageTools } from "./tools/mileage.js";

const server = new McpServer(
  {
    name: "freeagent-mcp-server",
    version: "2.0.0",
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

## Safety

Never set \`markExplained: true\` without a confirmed receipt or explicit user instruction. Transactions skipped due to missing receipts should be reported to the user for manual follow-up.
    `.trim(),
  }
);

registerAccountTools(server);
registerTransactionTools(server);
registerExpenseTools(server);
registerMileageTools(server);

async function main(): Promise<void> {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  if (port) {
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const http = await import("http");

    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => Math.random().toString(36).slice(2),
    });

    const httpServer = http.createServer(async (req, res) => {
      await httpTransport.handleRequest(req, res);
    });

    await server.connect(httpTransport);

    httpServer.listen(port, () => {
      process.stderr.write(
        `FreeAgent MCP server listening on http://localhost:${port}\n`
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
