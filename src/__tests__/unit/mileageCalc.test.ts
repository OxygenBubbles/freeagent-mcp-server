import { describe, it, expect } from "vitest";
import { calculateHMRCMileage, type HMRCRates } from "../../utils/mileageCalc.js";

const DEFAULT_RATES: HMRCRates = { highPence: 45, lowPence: 25, thresholdMiles: 10_000 };

// ── Single-rate cases ─────────────────────────────────────────────────────────

describe("calculateHMRCMileage — all miles at high rate", () => {
  it("100 miles with 0 cumulative → £45.00", () => {
    const result = calculateHMRCMileage(100, 0, DEFAULT_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") {
      expect(result.ratePence).toBe(45);
      expect(result.amountPounds).toBe("45.00");
    }
  });

  it("exactly at threshold boundary — all high rate", () => {
    const result = calculateHMRCMileage(100, 9_900, DEFAULT_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") {
      expect(result.ratePence).toBe(45);
      expect(result.amountPounds).toBe("45.00");
    }
  });
});

describe("calculateHMRCMileage — all miles at low rate", () => {
  it("100 miles with 10,000 cumulative → £25.00", () => {
    const result = calculateHMRCMileage(100, 10_000, DEFAULT_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") {
      expect(result.ratePence).toBe(25);
      expect(result.amountPounds).toBe("25.00");
    }
  });

  it("100 miles with 15,000 cumulative (well over threshold) → £25.00", () => {
    const result = calculateHMRCMileage(100, 15_000, DEFAULT_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") {
      expect(result.ratePence).toBe(25);
    }
  });
});

// ── Split-rate case ───────────────────────────────────────────────────────────

describe("calculateHMRCMileage — split across threshold", () => {
  it("1,000 miles with 9,500 cumulative → 500@45p + 500@25p = £350.00", () => {
    const result = calculateHMRCMileage(1_000, 9_500, DEFAULT_RATES);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.amountPounds).toBe("350.00");
      expect(result.highMiles).toBe(500);
      expect(result.lowMiles).toBe(500);
    }
  });

  it("1,000 miles with 9,000 cumulative → 1000@45p + 0@25p — but wait, all at high", () => {
    // 9,000 + 1,000 = 10,000 exactly — all at high rate
    const result = calculateHMRCMileage(1_000, 9_000, DEFAULT_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") expect(result.ratePence).toBe(45);
  });

  it("contains correct breakdown string", () => {
    const result = calculateHMRCMileage(1_000, 9_500, DEFAULT_RATES);
    expect(result.breakdown).toContain("500");
    expect(result.breakdown).toContain("45p");
    expect(result.breakdown).toContain("25p");
  });
});

// ── Configurable rates ────────────────────────────────────────────────────────

describe("calculateHMRCMileage — custom rates (HMRC update scenario)", () => {
  const UPDATED_RATES: HMRCRates = { highPence: 50, lowPence: 30, thresholdMiles: 10_000 };

  it("100 miles at high rate uses new 50p rate → £50.00", () => {
    const result = calculateHMRCMileage(100, 0, UPDATED_RATES);
    expect(result.type).toBe("single");
    if (result.type === "single") {
      expect(result.ratePence).toBe(50);
      expect(result.amountPounds).toBe("50.00");
    }
  });

  it("split case uses new rates — 500@50p + 500@30p = £400.00", () => {
    const result = calculateHMRCMileage(1_000, 9_500, UPDATED_RATES);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.amountPounds).toBe("400.00");
    }
  });

  it("custom threshold of 5,000 miles is respected", () => {
    const SHORT_THRESHOLD: HMRCRates = { highPence: 45, lowPence: 25, thresholdMiles: 5_000 };
    const result = calculateHMRCMileage(1_000, 4_500, SHORT_THRESHOLD);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.highMiles).toBe(500);
      expect(result.lowMiles).toBe(500);
    }
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("calculateHMRCMileage — edge cases", () => {
  it("very small fractional miles are handled without NaN", () => {
    const result = calculateHMRCMileage(0.5, 9_999.5, DEFAULT_RATES);
    // 9999.5 cumulative + 0.5 miles = 10000, all still at high rate
    expect(result.type).toBe("single");
    if (result.type === "single") expect(parseFloat(result.amountPounds)).toBeGreaterThan(0);
  });

  it("0 cumulative miles uses high rate", () => {
    const result = calculateHMRCMileage(100, 0, DEFAULT_RATES);
    expect(result.type).toBe("single");
  });

  it("breakdown string reflects the rates used", () => {
    const result = calculateHMRCMileage(100, 0, DEFAULT_RATES);
    expect(result.breakdown).toContain("45p");
  });
});
