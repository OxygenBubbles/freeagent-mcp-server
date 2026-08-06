/**
 * Choosing which bank transaction an expense reconciles against.
 *
 * Linking writes to the ledger, so the decision is deliberately conservative:
 * it only proceeds when exactly one candidate matches AND the whole candidate
 * set was searched. Auto-linking the first of several matches, or the first
 * match from a truncated page, can reconcile an expense against the wrong
 * transaction — which is worse than leaving it for a human, because it looks
 * finished.
 */

import { responseMoneyToMinor, toMinorUnits } from "./money.js";

export interface MatchCandidate {
  id: string;
  description: string;
  amount: string;
  dated_on?: string;
}

export function findMatchingTransactions(
  candidates: MatchCandidate[],
  opts: { amount: string; vendor: string; tolerancePence: number; minVendorLength: number }
): MatchCandidate[] {
  const upperVendor = opts.vendor.toUpperCase();
  // Compare in whole pence. In floating point |84.51 - 84.50| is
  // 0.0100000000000051, so a £0.01 tolerance rejects a penny difference —
  // the boundary case behaves the opposite way to how it reads.
  const targetMinor = Math.abs(toMinorUnits(opts.amount, "expense amount"));

  return candidates.filter((t) => {
    // Strict: a permissive parse could match the wrong transaction.
    let txMinor: number;
    try {
      txMinor = Math.abs(responseMoneyToMinor(t.amount, "bank transaction amount"));
    } catch {
      return false;
    }
    const amountMatch = Math.abs(txMinor - targetMinor) <= opts.tolerancePence;
    const descMatch =
      upperVendor.length >= opts.minVendorLength &&
      t.description.toUpperCase().includes(upperVendor);
    return amountMatch && descMatch;
  });
}

export type LinkDecision =
  | { action: "link"; match: MatchCandidate }
  | { action: "ambiguous"; matches: MatchCandidate[] }
  | { action: "incomplete"; matches: MatchCandidate[] }
  | { action: "none"; searchWasTruncated: boolean };

/** Decide whether a link may be written, given what was searched. */
export function decideLink(
  matches: MatchCandidate[],
  searchWasTruncated: boolean
): LinkDecision {
  if (matches.length > 1) return { action: "ambiguous", matches };
  if (matches.length === 1) {
    return searchWasTruncated
      ? { action: "incomplete", matches }
      : { action: "link", match: matches[0]! };
  }
  return { action: "none", searchWasTruncated };
}
