// FreeAgent API
export const FA_API_BASE = "https://api.freeagent.com/v2";
export const FA_TOKEN_URL = "https://api.freeagent.com/v2/token_endpoint";

// Response limits.
// FreeAgent rejects per_page above 100 with "Records limited to 100 per page",
// so this is a hard API ceiling, not a preference. Requests for more than a
// page are satisfied by paging, never by asking for a bigger page.
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

// How many records a list tool returns when the caller does not say.
export const DEFAULT_LIST_LIMIT = 100;

// Reports must cover the whole ledger, not one page — a truncated aged-debtors
// total is a wrong number. This bounds an unbounded fetch without realistically
// clipping a small company's books.
export const REPORT_MAX_RECORDS = 2000;

// Bank transaction matching (expense → bank entry)
export const DATE_TOLERANCE_DAYS = 4;
// Matching tolerance in whole pence. Comparing money as floats made the
// boundary case behave backwards: |84.51 - 84.50| is 0.0100000000000051.
export const AMOUNT_TOLERANCE_PENCE = 1;

// Mileage — HMRC approved mileage allowance payments (default rates)
export const HMRC_RATE_HIGH_PENCE = 45; // first 10,000 miles per tax year
export const HMRC_RATE_LOW_PENCE = 25;  // miles above 10,000
export const HMRC_THRESHOLD_MILES = 10_000;

// Default vendor → FreeAgent category URL mappings.
// Users can extend or override via the VENDOR_CATEGORIES env var (JSON).
//
// Nominal codes below are FreeAgent's standard UK chart of accounts:
//   268 Web Hosting            269 Computer Software
//   285 Accommodation and Meals  365 Travel
// (Earlier versions mapped software to 270 and hosting to 285. In a real
// account 270 is Computer Hardware and 285 is Accommodation and Meals, so
// every SaaS and hosting expense was being posted to the wrong nominal code.)
export const DEFAULT_VENDOR_CATEGORIES: Record<string, string> = {
  // Hosting / infrastructure → Web Hosting
  "IONOS": "/v2/categories/268",
  "Amazon Web Services": "/v2/categories/268",
  "Netlify": "/v2/categories/268",
  "Vercel": "/v2/categories/268",
  "Heroku": "/v2/categories/268",
  "DigitalOcean": "/v2/categories/268",
  "Cloudflare": "/v2/categories/268",

  // SaaS / subscriptions → Computer Software
  "OpenAI": "/v2/categories/269",
  "Anthropic": "/v2/categories/269",
  "GitHub": "/v2/categories/269",
  "Stripe": "/v2/categories/269",
  "Google": "/v2/categories/269",
  "Microsoft": "/v2/categories/269",
  "Zoom": "/v2/categories/269",
  "Notion": "/v2/categories/269",
  "Dropbox": "/v2/categories/269",
  "Slack": "/v2/categories/269",
  "Adobe": "/v2/categories/269",
  "Fastmail": "/v2/categories/269",
  "Mailchimp": "/v2/categories/269",

  // Travel and accommodation → Accommodation and Meals
  "Booking.com": "/v2/categories/285",
  "Hotels.com": "/v2/categories/285",
  "Premier Inn": "/v2/categories/285",
  "Travelodge": "/v2/categories/285",
  "Airbnb": "/v2/categories/285",

  // Transport → Travel
  "Trainline": "/v2/categories/365",
  "LNER": "/v2/categories/365",
  "Uber": "/v2/categories/365",
};
