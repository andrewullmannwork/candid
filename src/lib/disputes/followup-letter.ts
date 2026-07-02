/**
 * Follow-up letter — dispute-letters v2 S4 (map §3.3).
 *
 * A short, graduated nudge scheduled on the dispute_followups timer when a dispute has a governing
 * deadline: "I am following up on my [letter] of [date], to which I have not received a response;
 * a response is due by [deadline]." Addressed to the track department (Appeals / Compliance / the
 * collector). Carries the standard not-a-law-firm disclaimer (§1 legal invariant).
 *
 * NEW user-facing legal copy — drafted to the §3.3 spine + the §1 legal invariants (assert facts,
 * hedge, no threats, disclaimer on every letter; framework-anchored deadline language per §10).
 * Counsel review flagged in the post-launch tracker before this becomes user-reachable (S5/S6).
 *
 * Recipient is GENERIC-BY-TRACK at launch (no specific org name/address re-resolution here — the
 * nudge is short and the user has the address); S5/S6 may enrich from the case-page context.
 * At launch only insurance_appeal (insurer → Appeals) and debt_validation (collector) carry a
 * governing deadline, so those are the only reachable recipients; provider (Compliance) activates
 * with the state_timely_billing registry (INERT today).
 */
import type { LetterRecipientKind } from "@/lib/disputes";

const FOLLOWUP_DISCLAIMER =
  "DISCLAIMER: This letter was prepared using Candid, a consumer billing analysis tool. Candid is not a law firm, does not provide legal advice, and does not act as your legal representative.";

const RECIPIENT_SALUTATION: Record<LetterRecipientKind, string> = {
  insurer: "Appeals Department",
  provider: "Compliance Department",
  collector: "Collections Department",
};

// Human labels for the parent letter being followed up on. Only insurance_appeal + debt_validation
// are reachable at launch (they alone carry a governing deadline); the rest are for completeness.
const PARENT_LABEL: Record<string, string> = {
  insurance_appeal: "internal appeal",
  debt_validation: "debt-validation request",
  external_review: "external-review request",
  final_notice: "final escalation notice",
  overcharge: "billing dispute",
  balance_billing: "balance-billing dispute",
  duplicate_charge: "duplicate-charge dispute",
  itemized_request: "itemized-bill request",
  negotiation: "billing dispute",
};

/** UTC-safe long date (matches the templates.ts formatDate convention; no TZ off-by-one). */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// A counsel-blessed, framework-anchored sentence for the deadline being tracked (map §10).
function deadlineClause(deadlineType: string, deadlineDate: string): string {
  const when = formatDate(deadlineDate);
  switch (deadlineType) {
    case "plan_response":
      return `Under the applicable claims-review timeframe, a written determination on my appeal is due by ${when}.`;
    case "fdcpa_validation_30":
      return `The debt-validation period under the Fair Debt Collection Practices Act runs through ${when}.`;
    case "erisa_appeal_180":
      return `The applicable appeal window runs through ${when}.`;
    default:
      return `A written response is respectfully requested by ${when}.`;
  }
}

export interface FollowupLetterInput {
  recipientKind: LetterRecipientKind;
  parentLetterType: string;
  /** The parent letter's filed date (YYYY-MM-DD) — "my [letter] of [date]". */
  parentSentDate: string;
  /** The governing deadline (YYYY-MM-DD). */
  governingDeadlineDate: string;
  deadlineType: string;
  isFinal: boolean;
  /** Injectable letter date for deterministic tests; defaults to now. */
  now?: Date;
}

/**
 * Render the short follow-up letter body. Pure + fail-closed (a bad date degrades to the raw string
 * via formatDate, never a bracket placeholder; every field is present by construction).
 */
export function buildFollowupLetter(input: FollowupLetterInput): string {
  const salutation = RECIPIENT_SALUTATION[input.recipientKind];
  const parentLabel = PARENT_LABEL[input.parentLetterType] ?? "prior correspondence";
  const sent = formatDate(input.parentSentDate);
  const opener = input.isFinal
    ? `This is a final follow-up on my ${parentLabel} sent on ${sent}, to which I have not yet received a written response.`
    : `I am following up on my ${parentLabel} sent on ${sent}, to which I have not yet received a written response.`;

  return [
    formatDate((input.now ?? new Date()).toISOString()),
    "",
    `Re: Follow-up — ${parentLabel} of ${sent}`,
    "",
    `To the ${salutation}:`,
    "",
    opener,
    "",
    deadlineClause(input.deadlineType, input.governingDeadlineDate),
    "",
    `Please confirm receipt of my ${parentLabel} and provide a written response. If you have already responded, please disregard this notice.`,
    "",
    "Sincerely,",
    "",
    "",
    FOLLOWUP_DISCLAIMER,
  ].join("\n");
}
