// FreeAgent API
export const FA_API_BASE = "https://api.freeagent.com/v2";
export const FA_TOKEN_URL = "https://api.freeagent.com/v2/token_endpoint";

// Response limits
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Bank transaction matching (expense → bank entry)
export const DATE_TOLERANCE_DAYS = 4;
export const AMOUNT_TOLERANCE = 0.01; // £0.01 tolerance for floating-point

// Mileage — HMRC approved mileage allowance payments (default rates)
export const HMRC_RATE_HIGH_PENCE = 45; // first 10,000 miles per tax year
export const HMRC_RATE_LOW_PENCE = 25;  // miles above 10,000
export const HMRC_THRESHOLD_MILES = 10_000;

// Default vendor → FreeAgent category URL mappings.
// Users can extend via VENDOR_CATEGORIES env var (JSON).
export const DEFAULT_VENDOR_CATEGORIES: Record<string, string> = {
  "IONOS": "/v2/categories/285",
  "OpenAI": "/v2/categories/270",
  "Anthropic": "/v2/categories/270",
  "Amazon Web Services": "/v2/categories/285",
  "GitHub": "/v2/categories/270",
  "Stripe": "/v2/categories/270",
  "Google": "/v2/categories/270",
  "Microsoft": "/v2/categories/270",
  "Zoom": "/v2/categories/270",
  "Notion": "/v2/categories/270",
  "Dropbox": "/v2/categories/270",
  "Slack": "/v2/categories/270",
  "Adobe": "/v2/categories/270",
  "Netlify": "/v2/categories/285",
  "Vercel": "/v2/categories/285",
  "Heroku": "/v2/categories/285",
  "DigitalOcean": "/v2/categories/285",
  "Cloudflare": "/v2/categories/285",
  "Fastmail": "/v2/categories/270",
  "Mailchimp": "/v2/categories/270",
};
