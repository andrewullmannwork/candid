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

/** Letter types that require Candid Pro. Escalation (ladder-advance) letters only. */
export const PRO_LETTER_TYPES: readonly DisputeLetterType[] = [
  "final_notice", // provider R.. → R3
  "external_review", // insurer I1 → I2
];

/** True when a letter type requires Pro. Cheap; use to decide whether to load
 *  the subscription before the full evaluateLetterAccess call. */
export function letterRequiresPro(letterType: DisputeLetterType | null | undefined): boolean {
  return !!letterType && PRO_LETTER_TYPES.includes(letterType);
}

export interface LetterAccessInput {
  letterType: DisputeLetterType;
  isPro: boolean;
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
 * Today: escalation letters need Pro; everything else (first-contact letters +
 * debt_validation) is free.
 */
export function evaluateLetterAccess(input: LetterAccessInput): LetterAccessResult {
  const { letterType, isPro } = input;

  const requiresPro = PRO_LETTER_TYPES.includes(letterType);
  if (requiresPro && !isPro) {
    return { allowed: false, requiresPro: true, reason: "subscription_required" };
  }

  // Future per-count cap slots in here: if (freeQuota != null && disputeCount >=
  // freeQuota && !isPro) return { allowed: false, requiresPro: false,
  // reason: "free_quota_exceeded" };

  return { allowed: true, requiresPro };
}
