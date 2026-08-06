/**
 * Money handling.
 *
 * Currency is parsed with a strict decimal grammar and summed in integer minor
 * units (pence). Two properties matter here:
 *
 *  - `parseFloat` accepts a numeric PREFIX, so "22.80xyz" silently becomes
 *    22.8. For a value that ends up posted to a real ledger, a typo must fail
 *    rather than file a different amount.
 *  - Binary floating point cannot represent most decimal fractions, so
 *    0.1 + 0.2 !== 0.3. Summing many invoice values in `number` accumulates
 *    error; summing pence as integers does not.
 */

/** A decimal money literal: optional sign, digits, at most two decimal places. */
const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;

/** Beyond this, integer minor units are no longer exactly representable. */
const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * Parse a money string to integer minor units (pence).
 * Throws on anything that is not a clean 2dp decimal.
 */
export function toMinorUnits(value: string, label = "amount"): number {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!MONEY_RE.test(trimmed)) {
    throw new Error(
      `Invalid ${label} "${value}". Expected a decimal amount with at most 2 decimal places, e.g. "22.80".`
    );
  }

  const negative = trimmed.startsWith("-");
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = digits.split(".");
  const pence = fraction.padEnd(2, "0");

  const minor = Number(whole) * 100 + Number(pence);
  if (!Number.isSafeInteger(minor) || minor > MAX_SAFE_MINOR) {
    throw new Error(`Amount "${value}" is too large to handle precisely.`);
  }
  return negative ? -minor : minor;
}

/** Render integer minor units back to a 2dp decimal string. */
export function fromMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Cannot format non-integer minor units: ${minor}`);
  }
  const negative = minor < 0; // -0 is not negative, so "-0.00" cannot occur
  const abs = Math.abs(minor);
  const formatted = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${formatted}` : formatted;
}

/**
 * Parse a money string that a FreeAgent response supplied.
 *
 * Responses use a looser format than requests — "-46.2", "35000", "0.0" — so
 * a single decimal place is padded. Parsing stays on the string: going via
 * `Number(x) * 100` loses a penny at large values and silently re-rounds
 * anything with more precision than it should have.
 *
 * A value with more than two decimal places is refused rather than rounded:
 * FreeAgent stores money to two, so a third digit means the field is not what
 * this function was pointed at, and rounding it would invent a number.
 */
export function responseMoneyToMinor(
  value: string | undefined | null,
  label = "amount"
): number {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const trimmed = String(value).trim();

  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) {
    throw new Error(`FreeAgent returned a ${label} that is not a number: "${value}".`);
  }
  const [, sign, whole, fraction = ""] = m;
  if (fraction.length > 2) {
    throw new Error(
      `FreeAgent returned a ${label} with more precision than money should have: "${value}".`
    );
  }

  const pence = fraction.padEnd(2, "0");
  const wholeMinor = Number(whole) * 100;
  if (!Number.isSafeInteger(wholeMinor)) {
    throw new Error(`FreeAgent returned a ${label} too large to handle precisely: "${value}".`);
  }
  const minor = wholeMinor + Number(pence);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`FreeAgent returned a ${label} too large to handle precisely: "${value}".`);
  }
  return sign === "-" ? -minor : minor;
}

/**
 * Like responseMoneyToMinor, but a missing value is an error rather than zero.
 *
 * Use this where absence cannot be meaningfully treated as nil — an open
 * invoice with no outstanding value means the field moved or the record is not
 * what was expected, and silently counting it as £0 understates the total.
 */
export function requiredResponseMoneyToMinor(
  value: string | undefined | null,
  label = "amount"
): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(
      `FreeAgent returned no ${label}. Refusing to treat a missing amount as zero.`
    );
  }
  return responseMoneyToMinor(value, label);
}

/**
 * Sum money values as they came back from FreeAgent, exactly.
 *
 * Absent values are counted rather than quietly folded in as zero: a total
 * that skipped three records without saying so is a wrong number wearing a
 * confident face. Callers surface `missing` alongside the total.
 */
export function sumResponseMoney(
  values: Array<string | undefined | null>,
  label = "amount"
): { total: string; missing: number } {
  let total = 0;
  let missing = 0;
  for (const value of values) {
    if (value === undefined || value === null || String(value).trim() === "") {
      missing++;
      continue;
    }
    total += responseMoneyToMinor(value, label);
  }
  return { total: fromMinorUnits(total), missing };
}

/** Strict positive-decimal parse for non-money quantities such as hours. */
export function parseStrictDecimal(value: string, label: string): number {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${value}". Expected a number like "7.5".`);
  }
  return Number(trimmed);
}

/**
 * True when `value` is a real calendar date in YYYY-MM-DD form.
 *
 * A shape-only regex accepts "2026-99-99" and "2026-02-31"; Date.parse then
 * rolls the latter over to 3 March, so a typo becomes a plausible wrong date
 * rather than an error.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}
