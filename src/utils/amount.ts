/**
 * Parse a numeric string to a finite number.
 * Throws if the value is not a valid finite number (catches NaN, Infinity, empty string, etc.).
 */
export function parseAmount(value: string, fieldName = "amount"): number {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid ${fieldName}: "${value}" must be a valid finite number`);
  }
  return num;
}

/**
 * Add days to a YYYY-MM-DD date string using UTC arithmetic to avoid
 * timezone-driven off-by-one errors.
 */
export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0]!;
}
