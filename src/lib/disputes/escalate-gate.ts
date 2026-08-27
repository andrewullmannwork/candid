/**
 * escalate-gate — dispute-letters v2 Zone-3 (S266).
 *
 * Pure guard for POST /api/disputes/[disputeId]/escalate (spawning the next-rung
 * letter from a viewed dispute). Mirrors the /api/disputes/generate Case-1 gates
 * so the escalate path can't be a laxer bypass:
 *   - allowlist: escalate only produces the three ladder-advance letter types;
 *   - tier: final_notice / external_review are Pro (debt_validation is free —
 *     the consumer-protection funnel, matching generate's "free to start, pay to
 *     escalate");
 *   - exhaustion: external_review requires an attested final internal denial
 *     (ACA §2719 / ERISA — the review is only available post-exhaustion).
 *
 * Pure (no DB / no clock / no server imports) so it's unit-testable; the route
 * loads isPro from the subscription then calls this. Exercised by
 * scripts/calibration/fixtures/dispute-grounds/escalate-gating.ts.
 */
import type { DisputeLetterType } from "@/lib/billing/types";
import { evaluateLetterAccess } from "./letter-access";
import type { CaseLetterRef } from "./outcome-taxonomy";

/** The only letter types escalate may spawn (the ladder-advance rungs). */
export const ESCALATION_LETTER_TYPES = [
  "external_review", // insurer I1 → I2
  "final_notice", // provider R.. → R3
  "debt_validation", // collections interrupt → C1
] as const;

export type EscalationLetterType = (typeof ESCALATION_LETTER_TYPES)[number];

export function isEscalationLetterType(v: unknown): v is EscalationLetterType {
  return typeof v === "string" && (ESCALATION_LETTER_TYPES as readonly string[]).includes(v);
}

export type EscalateGateResult =
  | { ok: true; targetLetterType: EscalationLetterType }
  | { ok: false; status: number; error: string; reason?: string };

export function checkEscalateGate(input: {
  targetLetterType: unknown;
  isPro: boolean;
  appealExhausted?: { attested?: boolean | null } | null;
  /**
   * S303 — every letter already on the CLAIM, plus the source dispute's id.
   * Omitted by callers that cannot see the case (none today); when absent the
   * rung-taken check is skipped rather than guessed at.
   */
  caseLetters?: CaseLetterRef[];
  sourceDisputeId?: string;
}): EscalateGateResult {
  const { targetLetterType, isPro, appealExhausted, caseLetters, sourceDisputeId } = input;

  if (!isEscalationLetterType(targetLetterType)) {
    return { ok: false, status: 400, error: "unsupported_escalation_type" };
  }

  // S303 — the rung is already taken. The UI stopped OFFERING this (the
  // projector and the letter page both run nextRungStillOpen), but a stale tab
  // or a replayed request still could, and the consequence is a real row:
  // persistDisputeLetter's dedupe keys on line item + type and DELIBERATELY
  // excludes resolved statuses ("the user may legitimately open a fresh fight
  // after a prior one closed"), so a second external review on an exhausted
  // track sails straight past it and corrupts the per-case aggregates the
  // flywheel reads.
  //
  // ⚠ A DIFFERENT question from that dedupe, which is why it lives here rather
  // than there: dedupe asks *"is this the same letter again?"*; this asks
  // *"is this rung already taken on this claim?"* — any status but cancelled,
  // including a draft, and regardless of which line items it covers.
  if (caseLetters && sourceDisputeId) {
    const taken = caseLetters.some(
      (x) =>
        x.disputeId !== sourceDisputeId &&
        x.letterType === targetLetterType &&
        x.status !== "cancelled",
    );
    if (taken) {
      return {
        ok: false,
        status: 409,
        error: "escalation_rung_already_taken",
        reason: "You already have this letter on this bill.",
      };
    }
  }

  // Tier: escalation letters are Pro; debt_validation stays free. Single source
  // of truth for the rule — shared with /api/disputes/generate (Case 1).
  // userState: null is safe HERE ONLY because ESCALATION_LETTER_TYPES contains
  // no geo-gated type (S324) — the letter-geo-gate fixture asserts exactly that,
  // so adding a geo-gated type to the ladder fails CI until state is threaded.
  const access = evaluateLetterAccess({ letterType: targetLetterType, isPro, userState: null });
  if (!access.allowed) {
    return { ok: false, status: 403, error: access.reason ?? "subscription_required" };
  }

  // external_review exhaustion hard-gate (fail-closed): no attestation → refuse.
  if (targetLetterType === "external_review" && !appealExhausted?.attested) {
    return {
      ok: false,
      status: 400,
      error: "external_review_requires_exhaustion",
      reason: "Complete your plan's internal appeal before requesting an external review.",
    };
  }

  return { ok: true, targetLetterType };
}

/** Non-escalation letter types (the first-contact rungs) — escalate never spawns these. */
export function isFirstContactLetterType(t: DisputeLetterType): boolean {
  return !isEscalationLetterType(t);
}
