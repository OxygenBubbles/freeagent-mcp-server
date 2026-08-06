/**
 * Money must never be parsed permissively or summed in binary floating point.
 * A value that reaches a real ledger has to be exactly what was intended, or
 * the call has to fail.
 */
import { describe, it, expect } from "vitest";
import {
  toMinorUnits,
  fromMinorUnits,
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
  it("totals present values exactly and counts the absent ones", () => {
    // The absent entries must not vanish into the total as zero.
    expect(sumResponseMoney(["1200.50", undefined, "99.5", null])).toEqual({
      total: "1300.00",
      missing: 2,
    });
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

describe("responseMoneyToMinor precision", () => {
  it("is exact at large values where Number(x) * 100 drifts", async () => {
    const { responseMoneyToMinor, fromMinorUnits } = await import("../../utils/money.js");
    // Math.round(90071992547409.90 * 100) lands on 9007199254740991, which
    // formats back as ...09.91 — a penny invented by floating point.
    const minor = responseMoneyToMinor("90071992547409.90");
    expect(fromMinorUnits(minor)).toBe("90071992547409.90");
  });

  it("refuses more precision than money has, rather than silently rounding", async () => {
    const { responseMoneyToMinor } = await import("../../utils/money.js");
    // "1.005" previously became "1.00" with no indication anything was lost.
    expect(() => responseMoneyToMinor("1.005", "due value")).toThrow(/more precision/);
  });

  it("never produces negative zero", async () => {
    const { responseMoneyToMinor, fromMinorUnits } = await import("../../utils/money.js");
    expect(fromMinorUnits(responseMoneyToMinor("-0.00"))).toBe("0.00");
  });

  it("rejects a value too large to hold exactly", async () => {
    const { responseMoneyToMinor } = await import("../../utils/money.js");
    expect(() => responseMoneyToMinor("999999999999999999999")).toThrow(/too large/);
  });
});

describe("requiredResponseMoneyToMinor", () => {
  it("refuses a missing amount instead of counting it as zero", async () => {
    const { requiredResponseMoneyToMinor } = await import("../../utils/money.js");
    for (const missing of [undefined, null, "", "   "]) {
      expect(() => requiredResponseMoneyToMinor(missing, "due value")).toThrow(
        /Refusing to treat a missing amount as zero/
      );
    }
  });
});
