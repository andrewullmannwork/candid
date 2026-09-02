/**
 * business-days — the R18 runway arithmetic, PURE.
 *
 * R18 (S325): a matter arriving with fewer than N business days of deadline
 * runway is declined (or auto-refunded) at intake — the blown-appeal-deadline
 * case is the E&O scenario, and a deadline we cannot safely make is not a
 * matter we take. N is config-backed (`refusal_runway_business_days`).
 *
 * Business days here = Monday–Friday. Federal holidays are NOT excluded, so the
 * count can only OVERSTATE runway by the holidays inside the window (at most
 * one or two in a two-week span). The threshold is tunable without a deploy,
 * so the honest correction for a holiday-heavy week is to raise it, not to
 * bake a calendar into a legal gate. Date-only strings are read as calendar
 * dates (no timezone shift), matching the letter-date rule in letter-type.ts.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "YYYY-MM-DD" to a UTC-midnight Date; null on any other shape. */
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Whole business days strictly AFTER `from` up to and including `to`.
 * Negative when `to` is already behind `from` (the deadline has passed);
 * null when `to` is not a date-only string.
 */
export function businessDaysUntil(from: Date, to: string | null | undefined): number | null {
  const end = parseDateOnly(to);
  if (!end) return null;
  const start = utcDateOnly(from);
  const dir = end >= start ? 1 : -1;
  let count = 0;
  const cursor = new Date(start);
  while (cursor.getTime() !== end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + dir);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += dir;
  }
  return count;
}
