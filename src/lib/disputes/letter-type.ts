/**
 * letter-type — THE resolver from a stored dispute row to its letter template.
 *
 * Single source (S298). Until this module, three private copies lived in the
 * [disputeId] GET, the redraft route, and the timeline projector — and the
 * first two had ALREADY drifted: on legacy rows (no metadata.letterType) the
 * GET mapped `complaint → balance_billing` / default → overcharge while
 * redraft mapped `complaint → overcharge` / default → insurance_appeal, so a
 * legacy complaint letter would change template on redraft. Dead code on
 * current data (every row since ~S109 stamps metadata.letterType at persist;
 * 0 unstamped rows in the DEV corpus) — but exactly the drift consolidation
 * exists to kill.
 *
 * Corrected here (Andrew, S298): legacy `external_appeal → external_review`.
 * The old GET guess (`insurance_appeal`) mistook the insurer track's TERMINAL
 * letter for its first rung — a denied legacy external review would be
 * offered "Start the next letter — external review", an escalation to the
 * letter it already is.
 *
 * Source of truth (newer rows): metadata.letterType, stamped at persist.
 * Legacy fallback: dispute_type → letter type, GET semantics + the fix.
 */
import type { DisputeLetterType } from "@/lib/billing/types";

export function resolveLetterTypeFromDispute(dispute: {
  dispute_type: string;
  metadata?: Record<string, unknown> | null;
}): DisputeLetterType {
  const metaType =
    dispute.metadata && typeof dispute.metadata === "object"
      ? (dispute.metadata as { letterType?: string }).letterType
      : undefined;
  if (metaType) return metaType as DisputeLetterType;
  switch (dispute.dispute_type) {
    case "internal_appeal":
      return "insurance_appeal";
    case "negotiation":
      return "negotiation";
    case "complaint":
      return "balance_billing";
    case "external_appeal":
      return "external_review";
    default:
      return "overcharge";
  }
}

// ── Letter display semantics (S299) — labels + the ONE letter-date rule ─────
//
// LETTER_TYPE_LABELS moved here from the disputes page (page-local since the
// v2 build) so the case rail and the dispute page share one label source —
// the same drift class the resolver consolidation above killed.
//
// Date rule (S286 formatFiledDate, promoted repo-wide at S299): date-only
// strings ("2026-09-29" — governing deadlines, resolution dates) pin to LOCAL
// midnight (UTC-midnight parsing renders the PREVIOUS day in US timezones);
// full ISO timestamps (sent_at, outcomeReportedAt) parse natively and land on
// the user's LOCAL calendar. Calendar math is CLIENT-side only — a server
// computes calendars in ITS timezone (UTC on Vercel), which is exactly how
// the rail said "sent Jul 31" while the dispute page said "sent Jul 30" for
// the same send (S299 E2E catch, Andrew).

export const LETTER_TYPE_LABELS: Record<DisputeLetterType, string> = {
  insurance_appeal: "Appeal to Insurer",
  overcharge: "Billing Dispute",
  balance_billing: "Balance Billing Dispute",
  duplicate_charge: "Duplicate Charge Dispute",
  itemized_request: "Itemized Bill Request",
  negotiation: "Self-Pay Negotiation",
  final_notice: "Final Notice",
  external_review: "External Review Request",
  debt_validation: "Debt Validation",
};

/** The one parse rule: date-only → LOCAL midnight; timestamps → native. */
export function parseLetterDate(iso: string): Date | null {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00`) : Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "Sep 29" — the case rail's short date label. */
export function formatLetterDateShort(iso: string): string {
  const d = parseLetterDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Local start-of-day in ms (DST-safe via setHours). */
function startOfLocalDay(d: Date): number {
  const c = new Date(d.getTime());
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** Local-calendar days since `iso` (0 = same local day, 1 = yesterday). */
export function daysSinceLocal(iso: string, now: Date): number | null {
  const d = parseLetterDate(iso);
  if (!d) return null;
  return Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / 86_400_000);
}

/** Local-calendar days until `iso` (0 = today; negative = passed). */
export function daysUntilLocal(iso: string, now: Date): number | null {
  const d = parseLetterDate(iso);
  if (!d) return null;
  return Math.round((startOfLocalDay(d) - startOfLocalDay(now)) / 86_400_000);
}

/** "2026-07-30" — the LOCAL calendar date of a timestamp (payload-safe form). */
export function toLocalDateOnly(iso: string): string {
  const d = parseLetterDate(iso);
  if (!d) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
