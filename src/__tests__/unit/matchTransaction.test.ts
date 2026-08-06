/**
 * Auto-linking an expense to a bank transaction writes to the ledger, so the
 * decision has to be unambiguous and based on a complete search. A wrong link
 * is worse than no link: it looks reconciled.
 */
import { describe, it, expect } from "vitest";
import {
  findMatchingTransactions,
  decideLink,
  type MatchCandidate,
} from "../../utils/matchTransaction.js";

const tx = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id: "8000001",
  description: "EXAMPLE VENDOR LTD",
  amount: "-84.50",
  dated_on: "2026-04-15",
  ...over,
});

const opts = {
  amount: "84.50",
  vendor: "Example Vendor",
  tolerancePence: 1,
  minVendorLength: 3,
};

describe("findMatchingTransactions", () => {
  it("matches on absolute amount and vendor substring", () => {
    expect(findMatchingTransactions([tx()], opts)).toHaveLength(1);
  });

  it("ignores a transaction with a different amount", () => {
    expect(findMatchingTransactions([tx({ amount: "-12.00" })], opts)).toHaveLength(0);
  });

  it("ignores a transaction whose description omits the vendor", () => {
    expect(
      findMatchingTransactions([tx({ description: "SOME OTHER SHOP" })], opts)
    ).toHaveLength(0);
  });

  it("honours the amount tolerance at its boundary", () => {
    // Compared in pence. As floats, |84.51 - 84.50| is 0.0100000000000051,
    // so a £0.01 tolerance rejected the very case it was written to accept.
    expect(findMatchingTransactions([tx({ amount: "-84.51" })], opts)).toHaveLength(1);
    expect(findMatchingTransactions([tx({ amount: "-84.49" })], opts)).toHaveLength(1);
    expect(findMatchingTransactions([tx({ amount: "-84.52" })], opts)).toHaveLength(0);
  });

  it("skips a transaction whose amount cannot be parsed strictly", () => {
    expect(findMatchingTransactions([tx({ amount: "-84.50abc" })], opts)).toHaveLength(0);
  });

  it("refuses to match on a vendor name too short to be meaningful", () => {
    expect(
      findMatchingTransactions([tx({ description: "AB STORE" })], { ...opts, vendor: "AB" })
    ).toHaveLength(0);
  });
});

describe("decideLink", () => {
  it("links when exactly one match came from a complete search", () => {
    const decision = decideLink([tx()], false);
    expect(decision.action).toBe("link");
  });

  it("refuses to link when several transactions match", () => {
    // Picking .find()'s first result here reconciles against whichever
    // happened to come back first, which is arbitrary.
    const decision = decideLink([tx({ id: "1" }), tx({ id: "2" })], false);
    expect(decision.action).toBe("ambiguous");
  });

  it("refuses to link a lone match when the search was truncated", () => {
    // The unsearched remainder could hold the real counterpart.
    const decision = decideLink([tx()], true);
    expect(decision.action).toBe("incomplete");
  });

  it("reports no match when nothing matched", () => {
    expect(decideLink([], false).action).toBe("none");
    expect(decideLink([], true).action).toBe("none");
  });
});
