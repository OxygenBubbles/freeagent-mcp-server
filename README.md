# FreeAgent MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for [FreeAgent](https://www.freeagent.com) accounting. Gives Claude (or any MCP client) the ability to list bank transactions, explain/approve them with receipts, create expenses, and log mileage.

## What access this server requires

### FreeAgent

The FreeAgent OAuth credentials grant **full access** to the connected FreeAgent account. This server uses that access to:

| Action | Tools that use it |
|--------|------------------|
| Read bank accounts | `freeagent_list_bank_accounts` |
| Read bank transactions and explanations | `freeagent_list_transactions` |
| Update transaction explanations (category, description, approval, attachments) | `freeagent_explain_transaction` |
| Create expense claims | `freeagent_create_expense`, `freeagent_create_mileage_expense` |
| Read expense categories | `freeagent_list_categories` |

FreeAgent does not offer granular OAuth scopes — authorising an app grants access to all of the above. The server does **not** delete transactions, invoices, contacts, or any other data.

### Email and file sources (external — not provided by this server)

This server has no email tools. For receipt/invoice search to work automatically, connect one or more of the following MCP servers alongside this one:

- **Gmail** (e.g. `mcp__claude_ai_Gmail`) — personal email
- **Microsoft 365 / Outlook** (e.g. `mcp__claude_ai_microsoft-365`) — business email

When both are connected, Claude will search all of them automatically for matching receipts before asking you to provide a file manually.

---

## Tools

| Tool | Description |
|------|-------------|
| `freeagent_list_bank_accounts` | List all bank accounts and their IDs |
| `freeagent_list_transactions` | List transactions (unexplained / explained / all / marked_for_review) with date filters |
| `freeagent_explain_transaction` | Update, approve or attach a receipt to a transaction explanation |
| `freeagent_list_categories` | List the FreeAgent chart of accounts (expense categories) |
| `freeagent_create_expense` | Create an expense claim with optional receipt attachment and bank-transaction auto-matching |
| `freeagent_create_mileage_expense` | Create a mileage expense using HMRC rates, with optional distance auto-calculation |

---

## Prerequisites

### FreeAgent OAuth credentials

1. Log in to FreeAgent → **Settings → Developer API**.
2. Create an OAuth application. Set the redirect URI to `http://localhost:8080/callback`.
3. Note your **Client ID** and **Client Secret**.
4. Run the bundled auth command to complete the OAuth flow and save a refresh token to `.mcp.json` automatically:

```bash
npx @oxygenbubbles/freeagent-mcp-server auth
```

The command prompts for your Client ID and Client Secret, opens the FreeAgent authorization page in your browser, listens for the callback, exchanges the code for a long-lived refresh token, and writes everything to `.mcp.json` in the current directory. If `.mcp.json` already exists, it updates just the `freeagent` entry.

---

## Installation

```bash
git clone https://github.com/OxygenBubbles/freeagent-mcp-server.git
cd freeagent-mcp-server
npm install
npm run build
```

---

## Configuration

All settings are read from environment variables.

### Required

| Variable | Description |
|----------|-------------|
| `FREEAGENT_CLIENT_ID` | OAuth client ID |
| `FREEAGENT_CLIENT_SECRET` | OAuth client secret |
| `FREEAGENT_REFRESH_TOKEN` | Long-lived refresh token |

### Optional

| Variable | Description |
|----------|-------------|
| `VENDOR_CATEGORIES` | JSON object extending the built-in vendor → category mapping (see below) |
| `MILEAGE_CATEGORY_URL` | FreeAgent category URL for mileage expenses (default `/v2/categories/311`) |
| `MILEAGE_RATE_PENCE` | Fixed pence-per-mile rate; overrides HMRC logic when set |
| `HMRC_RATE_HIGH_PENCE` | HMRC high-band rate in pence (default `45`) |
| `HMRC_RATE_LOW_PENCE` | HMRC low-band rate in pence (default `25`) |
| `HMRC_THRESHOLD_MILES` | Miles per tax year before the low band kicks in (default `10000`) |
| `ORS_API_KEY` | [OpenRouteService](https://openrouteservice.org) API key for drive-distance lookups |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key for drive-distance lookups (alternative to ORS) |
| `PORT` | If set, serves over HTTP on this port instead of stdio |
| `AUTH_TOKEN` | Bearer token required on every HTTP request. Strongly recommended whenever `PORT` is set |

### Built-in vendor → category mappings

The server ships with mappings for common vendors (IONOS, OpenAI, Anthropic, AWS, GitHub, Stripe, Google, Microsoft, Zoom, Notion, Dropbox, Slack, Adobe, Netlify, Vercel, Heroku, DigitalOcean, Cloudflare, Fastmail, Mailchimp). Extend via `VENDOR_CATEGORIES`:

```bash
VENDOR_CATEGORIES='{"ACME CORP":"/v2/categories/285","NETFLIX":"/v2/categories/270"}'
```

---

## Claude Desktop setup

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "freeagent": {
      "command": "node",
      "args": ["/path/to/freeagent-mcp-server/dist/index.js"],
      "env": {
        "FREEAGENT_CLIENT_ID": "...",
        "FREEAGENT_CLIENT_SECRET": "...",
        "FREEAGENT_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

---

## Usage examples

```
List my unexplained Starling transactions for April 2026

Approve explanation 12345678 and attach the base64 receipt

Create an expense for the £22.80 IONOS charge on 3 April — here's the PDF: <base64>

Log 24 miles for a client visit from the office to a customer site on 10 April
```

---

## Mileage rates

When `ratePence` and `MILEAGE_RATE_PENCE` are both unset, HMRC approved rates apply automatically:

- **45p/mile** for the first 10,000 business miles in the tax year
- **25p/mile** above 10,000 miles

Pass `cumulativeMilesYTD` to enable the threshold crossover calculation.

HMRC has adjusted these rates historically. If they change again, override without editing source by setting `HMRC_RATE_HIGH_PENCE`, `HMRC_RATE_LOW_PENCE`, and/or `HMRC_THRESHOLD_MILES`.

---

## Development

```bash
npm run dev        # watch mode (tsx)
npm run build      # compile TypeScript → dist/
npm start          # run compiled server
npm test           # run unit tests once
npm run test:watch # watch mode for tests
```

---

## Claude Code setup

Create `.mcp.json` in your project directory (or `~/.mcp.json` for global access):

```json
{
  "mcpServers": {
    "freeagent": {
      "command": "node",
      "args": ["/path/to/freeagent-mcp-server/dist/index.js"],
      "env": {
        "FREEAGENT_CLIENT_ID": "...",
        "FREEAGENT_CLIENT_SECRET": "...",
        "FREEAGENT_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

---

## HTTP mode

Set `PORT` to run as an HTTP server (for webhooks, iPhone Shortcuts, Power Automate):

```bash
PORT=3000 AUTH_TOKEN=a-long-random-string node dist/index.js
```

Always set `AUTH_TOKEN` when exposing HTTP mode — every request must include `Authorization: Bearer <AUTH_TOKEN>` or it is rejected with 401. Without `AUTH_TOKEN` the server starts anyway but prints a warning to stderr and accepts all requests; only do that on a trusted loopback interface.

---

## Security

- Credentials are environment variables, never in code
- FreeAgent tokens are cached in memory and refreshed automatically
- Transactions are never approved without a confirmed receipt or explicit instruction
- The server never creates new categories — only selects from existing ones
- `.mcp.json` is excluded from git via `.gitignore`

---

## Licence

MIT
