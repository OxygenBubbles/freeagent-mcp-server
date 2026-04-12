import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listBankAccounts, handleFAError } from "../services/freeagent.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "freeagent_list_bank_accounts",
    {
      description:
        "List all bank accounts on the FreeAgent account. Returns account name, currency, current balance and status. Use this to find the bank account ID before listing transactions.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const accounts = await listBankAccounts();
        const rows = accounts.map((a) => ({
          id: a.url.split("/").pop() ?? a.url,
          name: a.name,
          currency: a.currency,
          balance: a.balance,
          type: a.type,
          status: a.status,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ bank_accounts: rows }, null, 2),
            },
          ],
          structuredContent: { bank_accounts: rows },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );
}
