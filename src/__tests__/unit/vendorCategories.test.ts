import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lookupCategory,
  getVendorCategories,
  _resetVendorCategoriesCache,
} from "../../utils/vendorCategories.js";

beforeEach(() => {
  _resetVendorCategoriesCache();
  delete process.env.VENDOR_CATEGORIES;
});

afterEach(() => {
  delete process.env.VENDOR_CATEGORIES;
  _resetVendorCategoriesCache();
});

describe("lookupCategory", () => {
  it("returns the URL for a known exact vendor", () => {
    expect(lookupCategory("IONOS")).toBe("/v2/categories/285");
  });

  it("matches case-insensitively", () => {
    expect(lookupCategory("ionos")).toBe("/v2/categories/285");
    expect(lookupCategory("Ionos")).toBe("/v2/categories/285");
  });

  it("does a fuzzy substring match", () => {
    expect(lookupCategory("IONOS Cloud Services Ltd")).toBe("/v2/categories/285");
    expect(lookupCategory("My OpenAI invoice")).toBe("/v2/categories/270");
  });

  it("returns undefined for an unknown vendor", () => {
    expect(lookupCategory("UnknownVendorXYZ")).toBeUndefined();
  });

  it("merges custom VENDOR_CATEGORIES on top of defaults", () => {
    process.env.VENDOR_CATEGORIES = JSON.stringify({ CustomVendor: "/v2/categories/999" });
    _resetVendorCategoriesCache();
    expect(lookupCategory("CustomVendor")).toBe("/v2/categories/999");
    // Defaults still work
    expect(lookupCategory("IONOS")).toBe("/v2/categories/285");
  });

  it("custom mapping overrides a default for the same key", () => {
    process.env.VENDOR_CATEGORIES = JSON.stringify({ IONOS: "/v2/categories/999" });
    _resetVendorCategoriesCache();
    expect(lookupCategory("IONOS")).toBe("/v2/categories/999");
  });

  it("falls back to defaults and emits a warning when VENDOR_CATEGORIES JSON is malformed", () => {
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg: string) => { warnings.push(msg); return true; };

    process.env.VENDOR_CATEGORIES = "{invalid json}";
    _resetVendorCategoriesCache();

    expect(lookupCategory("IONOS")).toBe("/v2/categories/285"); // defaults intact
    expect(warnings.some((w) => w.includes("VENDOR_CATEGORIES"))).toBe(true);

    process.stderr.write = original;
  });
});

describe("getVendorCategories", () => {
  it("caches the result — same reference on second call", () => {
    const first = getVendorCategories();
    const second = getVendorCategories();
    expect(first).toBe(second);
  });
});
