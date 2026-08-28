/**
 * letter-access — single source of truth for "which dispute letters need Pro".
 *
 * Free to start, pay to escalate (dispute-letters v2 S2): the first-contact
 * letters + debt_validation are FREE; only the escalation letters
 * (final_notice / external_review) require Candid Pro. This collapses the rule
 * that was duplicated in /api/disputes/generate (Case 1) and escalate-gate so
 * there is exactly one home for it — a laxer bypass on one path can't drift
 * from the other.
 *
 * Designed for a FUTURE per-count free cap ("we'll likely add a paywall for a
 * certain number of disputes later"): add `disputeCount` / `freeQuota` to
 * LetterAccessInput and one branch in evaluateLetterAccess — every caller picks
 * it up for free, no rewrite.
 */
import type { DisputeLetterType } from "@/lib/billing/types";

/**
 * Letter types that require Candid Pro.
 *
 * EMPTY since S299 (Andrew): the escalation-letter Pro wall is REMOVED for now
 * — every ladder rung (final_notice, external_review) is free like the
 * first-contact letters. Rationale: unblocks end-to-end testing of the case
 * rail's "Start the next letter" path, and "no one will be upset that it ends
 * up being free." The MACHINERY stays intact — evaluateLetterAccess,
 * letterRequiresPro, the escalate-gate tier check, Pro chips, and the 403
 * paths all still consult this ONE list — so restoring the wall is exactly
 * re-adding the type(s) here (previously: "final_notice", "external_review").
 * The Case File download tier gate is a separate check and is unaffected.
 */
export const PRO_LETTER_TYPES: readonly DisputeLetterType[] = [];

/** True when a letter type requires Pro. Cheap; use to decide whether to load
 *  the subscription before the full evaluateLetterAccess call. */
export function letterRequiresPro(letterType: DisputeLetterType | null | undefined): boolean {
  return !!letterType && PRO_LETTER_TYPES.includes(letterType);
}

/**
 * Letter types that are unavailable in specific U.S. states (S324, 2026-08-26).
 *
 * `negotiation` (the self-pay "accept less than billed" letter) is a regulated
 * debt-settlement service under California's CCFPL registration regime
 * (10 CCR § 1001(b)(1) + § 1010(a)); it is gated for California residents
 * until Candid's DFPI registration is effective. The error-dispute and
 * insurer-appeal letters assert the CORRECT amount / coverage and are a
 * different analysis — they are deliberately NOT gated.
 *
 * ⚠ This is a LEGAL gate, not a product cap: it changes only via a reviewed PR
 * (no feature flag, no DB config — a flag that could switch it off would
 * defeat its purpose). `gateUnknownState: true` = fail closed when we do not
 * know the user's state.
 *
 * ⚠ UN-GATING CA IS SEQUENCED — do not remove "CA" from this list without the
 * runbook (Andrew ruling R15, S325). The lawful ORDER is: business decision →
 * marketing cleanup verified → DFPI registration FILED (~45 days ahead) →
 * registration EFFECTIVE → then this PR. Registration pending ≠ registered;
 * un-gating first makes the first letter sent an unregistered-period violation.
 * Runbook: vault plans/candid-legal-review-and-dfy-monetization-2026-08-26.md §2.
 */
export const GEO_GATED_LETTER_TYPES: Partial<
  Record<DisputeLetterType, { states: readonly string[]; gateUnknownState: boolean }>
> = {
  negotiation: { states: ["CA"], gateUnknownState: true },
};

/** True when a letter type has any geo restriction — callers use this to decide
 *  whether the user's state must be loaded before evaluateLetterAccess. */
export function letterGeoRelevant(letterType: DisputeLetterType | null | undefined): boolean {
  return !!letterType && letterType in GEO_GATED_LETTER_TYPES;
}

/** ONE home for the user-facing copy shown when the geo gate refuses. */
export const GEO_GATE_MESSAGE =
  "Self-pay negotiation letters aren't available to California residents right now. Your other letter options are unaffected.";

/** S326 (Rule 8) — the claim-scoped litigation screening step id (the guide-
 *  step key under claims.metadata.guideSteps). Lives HERE (pure module) so the
 *  client composition step and the server loader read ONE constant;
 *  letter-access-state re-exports it for its reader. */
export const LITIGATION_STEP_ID = "screening:litigation";

/** ONE home for the user-facing copy shown when the litigation hold refuses
 *  (S326 Rule 8). Factual and directive — no legal advice, no composed
 *  posture: the matter needs a lawyer, and we say so plainly. */
export const LITIGATION_HOLD_MESSAGE =
  "You told us there's a lawsuit over this bill. Once a bill is in litigation, letters aren't the right tool — this needs a lawyer. We've kept your records ready to share with one, and our self-help resources explain how to find free or low-cost legal aid.";

export interface LetterAccessInput {
  letterType: DisputeLetterType;
  isPro: boolean;
  /**
   * The user's profile state (profiles.state, e.g. "CA"), or null when absent.
   * REQUIRED (not optional) so no future call site can compile without deciding
   * how it sources the state — pass null only to mean "no state on file",
   * which FAILS CLOSED for geo-gated types. Callers may skip the DB read when
   * `letterGeoRelevant(letterType)` is false and pass null.
   */
  userState: string | null;
  /**
   * S326 (eleven-rules Rule 8 — the kill-switch's litigation slice). The
   * claim's litigation screening answer: `true` = the member attested a
   * lawsuit exists / they were served over this bill → EVERY letter type is
   * refused (litigation demands counsel, not composed letters; the UI routes
   * to published self-help materials + find-a-lawyer resources). `false` =
   * answered no; `null` = never asked (legacy claims — the gate is inert, an
   * honest limitation: the QUESTION ships inside the flagged composition
   * step, but this GATE is unflagged and permanent, like the geo gate — a
   * legal gate must not be flaggable). REQUIRED (the S301/S324 lesson): every
   * call site must decide how it sources the answer — read from
   * `claims.metadata.guideSteps["screening:litigation"].note` ("yes"/"no").
   */
  litigationAttested: boolean | null;
  // Future per-count cap inputs go here (disputeCount?, freeQuota?) — one added
  // branch below, callers unchanged.
}

export interface LetterAccessResult {
  /** May this letter be generated for this user? */
  allowed: boolean;
  /** Did the gate turn on because the type is Pro-only? (vs a future quota cap) */
  requiresPro: boolean;
  /** Machine-readable denial reason when !allowed. */
  reason?: string;
}

/**
 * Decide whether a user may generate a given dispute letter type.
 * Geo first (a legal gate — Pro cannot buy past it), then tier: escalation
 * letters need Pro when listed; everything else is free.
 */
export function evaluateLetterAccess(input: LetterAccessInput): LetterAccessResult {
  const { letterType, isPro, userState, litigationAttested } = input;

  // S326 — litigation FIRST: it outranks geo and tier because it blocks every
  // type (a matter in litigation gets no composed letters of any kind).
  if (litigationAttested === true) {
    return { allowed: false, requiresPro: false, reason: "litigation_hold" };
  }

  const geo = GEO_GATED_LETTER_TYPES[letterType];
  if (geo) {
    const state = userState?.trim().toUpperCase() || null;
    const gated = state ? geo.states.includes(state) : geo.gateUnknownState;
    if (gated) {
      return { allowed: false, requiresPro: false, reason: "geo_unavailable" };
    }
  }

  const requiresPro = PRO_LETTER_TYPES.includes(letterType);
  if (requiresPro && !isPro) {
    return { allowed: false, requiresPro: true, reason: "subscription_required" };
  }

  // Future per-count cap slots in here: if (freeQuota != null && disputeCount >=
  // freeQuota && !isPro) return { allowed: false, requiresPro: false,
  // reason: "free_quota_exceeded" };

  return { allowed: true, requiresPro };
}
