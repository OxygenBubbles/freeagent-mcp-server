import { describe, it, expect } from "vitest";
import { parseAmount, addDays } from "../../utils/amount.js";

// ── parseAmount ───────────────────────────────────────────────────────────────

describe("parseAmount", () => {
  it("parses a valid positive decimal", () => {
    expect(parseAmount("22.80")).toBeCloseTo(22.8);
  });

  it("parses an integer string", () => {
    expect(parseAmount("100")).toBe(100);
  });

  it("parses the smallest valid value", () => {
    expect(parseAmount("0.01")).toBeCloseTo(0.01);
  });

  it.each([
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["abc"],
    [""],
    ["1e999"],
  ])('throws on invalid input "%s"', (val) => {
    expect(() => parseAmount(val)).toThrow(/Invalid amount/);
  });

  it("includes fieldName in the error message", () => {
    expect(() => parseAmount("abc", "grossAmount")).toThrow(/grossAmount/);
  });
});

// ── addDays ───────────────────────────────────────────────────────────────────

describe("addDays", () => {
  it("adds positive days", () => {
    expect(addDays("2026-04-10", 4)).toBe("2026-04-14");
  });

  it("subtracts days (negative offset)", () => {
    expect(addDays("2026-04-10", -4)).toBe("2026-04-06");
  });

  it("rolls over month boundary", () => {
    expect(addDays("2026-04-28", 4)).toBe("2026-05-02");
  });

  it("rolls over year boundary", () => {
    expect(addDays("2025-12-30", 4)).toBe("2026-01-03");
  });

  it("handles leap year", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
  });

  it("zero offset returns same date", () => {
    expect(addDays("2026-04-12", 0)).toBe("2026-04-12");
  });
});
