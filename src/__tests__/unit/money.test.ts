/**
 * Money must never be parsed permissively or summed in binary floating point.
 * A value that reaches a real ledger has to be exactly what was intended, or
 * the call has to fail.
 */
import { describe, it, expect } from "vitest";
import {
  toMinorUnits,
  fromMinorUnits,
  sumMoney,
  sumResponseMoney,
  responseMoneyToMinor,
  parseStrictDecimal,
  isCalendarDate,
} from "../../utils/money.js";

describe("toMinorUnits", () => {
  it("converts a decimal string to pence", () => {
    expect(toMinorUnits("22.80")).toBe(2280);
    expect(toMinorUnits("0.01")).toBe(1);
    expect(toMinorUnits("100")).toBe(10_000);
    expect(toMinorUnits("-84.50")).toBe(-8450);
  });

  it("pads a single decimal place", () => {
    expect(toMinorUnits("12.5")).toBe(1250);
  });

  it("rejects a numeric PREFIX — parseFloat would have accepted these", () => {
    // This is the whole point: parseFloat("22.80xyz") === 22.8, which would
    // have quietly filed a different amount than the user typed.
    for (const bad of ["22.80xyz", "£22.80", "22,80", "1e3", "12abc", "22.80.00"]) {
      expect(() => toMinorUnits(bad), bad).toThrow(/Invalid amount/);
    }
  });

  it("tolerates surrounding whitespace but nothing else", () => {
    expect(toMinorUnits("  22.80  ")).toBe(2280);
    expect(() => toMinorUnits("22. 80")).toThrow(/Invalid amount/);
  });

  it("rejects more than two decimal places", () => {
    expect(() => toMinorUnits("22.805")).toThrow(/at most 2 decimal places/);
  });

  it("rejects empty, whitespace and non-numeric values", () => {
    for (const bad of ["", "   ", "abc", "NaN", "Infinity", "-"]) {
      expect(() => toMinorUnits(bad)).toThrow(/Invalid amount/);
    }
  });

  it("names the field in the error so the caller knows what to fix", () => {
    expect(() => toMinorUnits("nope", "bill line value")).toThrow(/Invalid bill line value/);
  });
});

describe("fromMinorUnits", () => {
  it("always renders two decimal places", () => {
    expect(fromMinorUnits(2280)).toBe("22.80");
    expect(fromMinorUnits(5)).toBe("0.05");
    expect(fromMinorUnits(0)).toBe("0.00");
    expect(fromMinorUnits(-8450)).toBe("-84.50");
    expect(fromMinorUnits(-5)).toBe("-0.05");
  });

  it("round-trips through minor units", () => {
    for (const v of ["0.01", "12.50", "-3.07", "1000000.99"]) {
      expect(fromMinorUnits(toMinorUnits(v))).toBe(
        v.includes(".") ? v : `${v}.00`
      );
    }
  });
});

describe("sumMoney", () => {
  it("sums exactly where floating point would drift", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a JS number.
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
  });

  it("stays exact over many additions", () => {
    const pennies = Array.from({ length: 1000 }, () => "0.01");
    expect(sumMoney(pennies)).toBe("10.00");
  });

  it("handles an empty list", () => {
    expect(sumMoney([])).toBe("0.00");
  });

  it("propagates a malformed entry rather than skipping it", () => {
    expect(() => sumMoney(["1.00", "oops"])).toThrow(/Invalid amount/);
  });
});

describe("responseMoneyToMinor", () => {
  it("accepts the looser formats FreeAgent returns", () => {
    expect(responseMoneyToMinor("-46.2")).toBe(-4620);
    expect(responseMoneyToMinor("35000")).toBe(3_500_000);
    expect(responseMoneyToMinor("0.0")).toBe(0);
  });

  it("treats a missing value as zero", () => {
    expect(responseMoneyToMinor(undefined)).toBe(0);
    expect(responseMoneyToMinor(null)).toBe(0);
    expect(responseMoneyToMinor("")).toBe(0);
  });

  it("throws on a non-numeric response rather than silently zeroing it", () => {
    expect(() => responseMoneyToMinor("n/a", "due value")).toThrow(
      /returned a due value that is not a number/
    );
  });
});

describe("sumResponseMoney", () => {
  it("totals a mix of present and absent values exactly", () => {
    expect(sumResponseMoney(["1200.50", undefined, "99.5", null])).toBe("1300.00");
  });
});

describe("parseStrictDecimal", () => {
  it("accepts plain decimals", () => {
    expect(parseStrictDecimal("7.5", "hours")).toBe(7.5);
  });

  it("rejects a numeric prefix", () => {
    expect(() => parseStrictDecimal("7.5h", "hours")).toThrow(/Invalid hours/);
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates including a leap day", () => {
    expect(isCalendarDate("2026-08-06")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
  });

  it("rejects impossible dates a shape-only regex would allow", () => {
    // Date.parse rolls 2026-02-31 over to 3 March, turning a typo into a
    // plausible wrong date.
    for (const bad of ["2026-99-99", "2026-02-31", "2026-13-01", "2026-00-10", "2026-8-6"]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });
});
