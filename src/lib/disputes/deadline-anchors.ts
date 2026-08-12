/**
 * S309 F15 — ONE validator for user-entered deadline anchors (denial received,
 * collector first contact). Extracted from the deadline-inputs route when the
 * escalate route turned out to be a second, UNGUARDED writer of the same
 * fields (the drift pattern): letters recite these anchors verbatim, so every
 * write path must hold the same line.
 *
 * The floor exists because the browser date input lets a 3-digit year through
 * ("Jun 5, 203" → "0203-06-05"), which is four \d's AND in the past — it
 * slipped both the format regex and the future-date guard live (Andrew's
 * S309 catch). No live deadline anchor predates 2000-01-01.
 */

export const ANCHOR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_ANCHOR_DATE = "2000-01-01";

/**
 * A deadline anchor is either null (clear) or a "YYYY-MM-DD" between
 * MIN_ANCHOR_DATE and today inclusive. Future dates are rejected — anchors
 * record something that already happened. String comparison is valid for
 * YYYY-MM-DD ordering.
 */
export function validateAnchor(
  value: unknown,
  todayIso: string,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !ANCHOR_DATE_RE.test(value)) return { ok: false };
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || value > todayIso || value < MIN_ANCHOR_DATE) return { ok: false };
  return { ok: true, value };
}
