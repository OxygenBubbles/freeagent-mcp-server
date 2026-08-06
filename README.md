# FreeAgent MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for [FreeAgent](https://www.freeagent.com) accounting. Gives Claude (or any MCP client) the ability to reconcile bank transactions with receipts, claim expenses and mileage, raise and chase invoices, record supplier bills, log time against projects, and read the company's financial position.

## What access this server requires

### FreeAgent

The FreeAgent OAuth credentials grant **full access** to the connected FreeAgent account. This server uses that access to:

| Action | Tools that use it |
|--------|------------------|
| Read bank accounts | `freeagent_list_bank_accounts` |
| Read bank transactions and explanations | `freeagent_list_transactions` |
| Update transaction explanations (category, description, approval, attachments) | `freeagent_explain_transaction` |
| Create expense claims | `freeagent_create_expense`, `freeagent_create_mileage_expense` |
| Read the chart of accounts and projects | `freeagent_list_categories`, `freeagent_list_projects` |
| Read and create contacts | `freeagent_list_contacts`, `freeagent_create_contact` |
| Read, raise and change the status of invoices | `freeagent_list_invoices`, `freeagent_get_invoice`, `freeagent_create_invoice`, `freeagent_update_invoice_status` |
| Read and record supplier bills | `freeagent_list_bills`, `freeagent_create_bill` |
| Read and log time against project tasks | `freeagent_list_tasks`, `freeagent_create_task`, `freeagent_list_timeslips`, `freeagent_create_timeslip` |
| Read accounting reports | `freeagent_profit_and_loss`, `freeagent_trial_balance`, `freeagent_aged_debtors`, `freeagent_aged_creditors`, `freeagent_tax_timeline`, `freeagent_company_summary` |
| Delete invoices, bills and timeslips | `freeagent_delete_invoice`, `freeagent_delete_bill`, `freeagent_delete_timeslip` |

FreeAgent does not offer granular OAuth scopes — authorising an app grants access to all of the above.

**Destructive operations.** The delete tools are flagged `destructiveHint: true` so your MCP client can prompt before running them, as is `freeagent_update_invoice_status` (its `mark_as_cancelled` transition voids an issued invoice). The server never deletes bank transactions or contacts, and never emails anything to your clients — status transitions change status only.

**Outbound fetches.** `freeagent_explain_transaction` accepts a `fileUrl` to download a receipt. That URL is treated as untrusted input: only `http`/`https` are allowed, hosts resolving to loopback, link-local, or private addresses are refused (on the initial request *and* on every redirect), and downloads are capped at 10 MB.

**Truncation.** List tools page through results and report `mayHaveMore`; when true, any total they return covers only the records fetched and is named `totalOutstandingForReturned`. The `freeagent_aged_debtors` and `freeagent_aged_creditors` reports page to exhaustion and return `complete: true` — treat `complete: false` as an incomplete figure. Records whose due date is missing or unparseable are counted in a separate `unknown_due_date` bucket rather than being assumed not yet due.

### Email and file sources (external — not provided by this server)

This server has no email tools. For receipt/invoice search to work automatically, connect one or more of the following MCP servers alongside this one:

- **Gmail** (e.g. `mcp__claude_ai_Gmail`) — personal email
- **Microsoft 365 / Outlook** (e.g. `mcp__claude_ai_microsoft-365`) — business email

When both are connected, Claude will search all of them automatically for matching receipts before asking you to provide a file manually.

---

## Tools

### Banking and expenses

| Tool | Description |
|------|-------------|
| `freeagent_list_bank_accounts` | List all bank accounts and their IDs |
| `freeagent_list_transactions` | List transactions (unexplained / explained / all / marked_for_review) with date filters |
| `freeagent_explain_transaction` | Update, approve or attach a receipt to a transaction explanation |
| `freeagent_list_categories` | List the full chart of accounts — all four category groups |
| `freeagent_list_projects` | List projects, for tagging expenses, invoices, bills and time |
| `freeagent_create_expense` | Create an expense claim with optional receipt attachment, project tag and bank-transaction auto-matching |
| `freeagent_create_mileage_expense` | Create a mileage claim; FreeAgent calculates the value from the account's mileage rate |

### Contacts, invoicing and bills

| Tool | Description |
|------|-------------|
| `freeagent_list_contacts` | List clients and suppliers, with an optional name/email filter |
| `freeagent_create_contact` | Create a client or supplier |
| `freeagent_list_invoices` | List invoices by view (`overdue`, `open_or_overdue`, `draft`, `paid`…) with the total outstanding |
| `freeagent_get_invoice` | Fetch one invoice in full, including line items |
| `freeagent_create_invoice` | Raise an invoice with line items — always created as a **draft** |
| `freeagent_update_invoice_status` | Mark an invoice as sent, draft, scheduled or cancelled (no email is sent) |
| `freeagent_delete_invoice` | Delete an invoice |
| `freeagent_list_bills` | List supplier bills with the total outstanding |
| `freeagent_create_bill` | Record a supplier bill, with optional PDF attachment and project allocation |
| `freeagent_delete_bill` | Delete a bill |

### Time tracking

| Tool | Description |
|------|-------------|
| `freeagent_list_tasks` | List project tasks (time is always logged against a task) |
| `freeagent_create_task` | Create a project task with its billing rate |
| `freeagent_list_timeslips` | List logged time for a date range, with totals per project; `view: "unbilled"` finds uninvoiced work |
| `freeagent_create_timeslip` | Log time against a project task |
| `freeagent_delete_timeslip` | Delete a timeslip |

### Reporting

| Tool | Description |
|------|-------------|
| `freeagent_profit_and_loss` | Income, expenses, operating profit, corporation tax estimate and retained profit |
| `freeagent_trial_balance` | Balance on every nominal account |
| `freeagent_aged_debtors` | Unpaid customer invoices bucketed by age (not yet due, 1–30, 31–60, 61–90, 90+ days) |
| `freeagent_aged_creditors` | Unpaid supplier bills bucketed by age |
| `freeagent_tax_timeline` | Upcoming VAT, corporation tax and Companies House deadlines with amounts due |
| `freeagent_company_summary` | Company details, VAT registration and accounting year end |

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
| `MILEAGE_CATEGORY_URL` | FreeAgent category URL for mileage expenses (default `/v2/categories/249`, the standard Mileage category) |
| `MILEAGE_RATE_PENCE` | Fixed pence-per-mile rate used for the advisory estimate (FreeAgent still calculates the filed amount) |
| `HMRC_RATE_HIGH_PENCE` | HMRC high-band rate in pence for the advisory estimate (default `45`) |
| `HMRC_RATE_LOW_PENCE` | HMRC low-band rate in pence for the advisory estimate (default `25`) |
| `HMRC_THRESHOLD_MILES` | Miles per tax year before the low band kicks in (default `10000`) |
| `ORS_API_KEY` | [OpenRouteService](https://openrouteservice.org) API key for drive-distance lookups |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key for drive-distance lookups (alternative to ORS) |
| `PORT` | If set, serves over HTTP on this port instead of stdio |
| `AUTH_TOKEN` | Bearer token required on every HTTP request. Strongly recommended whenever `PORT` is set |
| `FREEAGENT_DEBUG` | Set to `1` to log every request and error response to stderr. Tokens, credentials and file payloads are redacted |

### Built-in vendor → category mappings

The server ships with mappings for common vendors, using FreeAgent's standard UK nominal codes:

- **Web Hosting (268)** — IONOS, AWS, Netlify, Vercel, Heroku, DigitalOcean, Cloudflare
- **Computer Software (269)** — OpenAI, Anthropic, GitHub, Stripe, Google, Microsoft, Zoom, Notion, Dropbox, Slack, Adobe, Fastmail, Mailchimp
- **Accommodation and Meals (285)** — Booking.com, Hotels.com, Premier Inn, Travelodge, Airbnb
- **Travel (365)** — Trainline, LNER, Uber

Check these against your own chart of accounts with `freeagent_list_categories` — nominal codes can be customised per account. Override or extend via `VENDOR_CATEGORIES`:

```bash
VENDOR_CATEGORIES='{"ACME CORP":"/v2/categories/285","NETFLIX":"/v2/categories/269"}'
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

Mileage is a special FreeAgent category: you submit the **miles and vehicle type**, and FreeAgent calculates the claim value from the mileage rate configured on the account. That figure is what appears in your accounts and HMRC reporting, so the server does not attempt to override it.

`ratePence`, `MILEAGE_RATE_PENCE`, `cumulativeMilesYTD` and the `HMRC_*` variables produce an **advisory estimate** returned alongside the filed amount. When the two differ, the response says so:

> FreeAgent filed £46.20 using the mileage rate configured on the account; the estimate from 84 miles @ 45p/mile (HMRC) was £37.80.

That is a useful check: HMRC's approved rates are 45p/mile for the first 10,000 business miles in the tax year and 25p above it, and anything paid above the approved rate is a taxable benefit. If the two figures disagree, check the mileage rate in your FreeAgent settings.

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
