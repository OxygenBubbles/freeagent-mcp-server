import { DEFAULT_VENDOR_CATEGORIES } from "../constants.js";

// Parsed once on first access; env vars don't change during process lifetime.
let cached: Record<string, string> | null = null;

export function getVendorCategories(): Record<string, string> {
  if (cached) return cached;

  let custom: Record<string, string> = {};
  if (process.env.VENDOR_CATEGORIES) {
    try {
      custom = JSON.parse(process.env.VENDOR_CATEGORIES) as Record<string, string>;
    } catch (err) {
      process.stderr.write(
        `Warning: Failed to parse VENDOR_CATEGORIES env var: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  cached = { ...DEFAULT_VENDOR_CATEGORIES, ...custom };
  return cached;
}

export function lookupCategory(vendor: string): string | undefined {
  const map = getVendorCategories();
  if (map[vendor]) return map[vendor];
  const upper = vendor.toUpperCase();
  for (const [pattern, url] of Object.entries(map)) {
    if (upper.includes(pattern.toUpperCase())) return url;
  }
  return undefined;
}

/** Exported for tests only — resets the module-level cache. */
export function _resetVendorCategoriesCache(): void {
  cached = null;
}
