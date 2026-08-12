/**
 * S309 F13 (Andrew's ruling, 2026-08-11) — ONE clock for user-facing dates:
 * EASTERN, fixed, regardless of the user's device timezone. "Accuracy is most
 * important in allowing the recipient of the letter to find the record
 * themselves" — a recipient reconciles against one predictable clock, and an
 * evening-Pacific session must not date its letter (or recite a phone call)
 * tomorrow, which is what serverless-UTC formatting did.
 *
 * Two value classes, never conflated:
 *  - `plainDate` — DATE-ONLY ISO values ("2023-08-02": dates of service,
 *    deadline dates). UTC-pinned so the calendar date never shifts (the S109
 *    rule, centralized here from three private copies that had drifted into
 *    templates.ts / followup-letter.ts / casefile).
 *  - `easternDate` — INSTANTS (letter datelines, call/sent/created
 *    timestamps). Pinned to America/New_York — the Eastern clock, printing
 *    EST or EDT as the calendar says; bare "EST" year-round would mislabel
 *    half the year, and letters print plain dates with no zone label anyway.
 *
 * The old letters-pipeline stance ("UTC, deliberately — consistency across
 * one letter matters more than per-field cleverness", prior-contact.ts) is
 * SATISFIED by this design rather than overturned: every instant in every
 * letter moves to the same clock together, and the accepted ±1-day exposure
 * goes to zero.
 */

export const USER_DATE_TIME_ZONE = "America/New_York";

const LONG: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
};

/** DATE-ONLY ISO ("2023-08-02") → "August 2, 2023". UTC-pinned: never shifts. */
export function plainDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { ...LONG, timeZone: "UTC" });
}

/** An INSTANT (Date or ISO timestamp) → its EASTERN calendar date, long form. */
export function easternDate(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return d.toLocaleDateString("en-US", { ...LONG, timeZone: USER_DATE_TIME_ZONE });
}
