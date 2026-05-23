/**
 * `deriveBillState` — single source of truth for per-bill 4-state classification.
 *
 * Phase 2 B1.3b implementation per plans/s112_phase1_ui_integration.md §1.D.1-C
 * (richer impl spec) + §0.10/§0.7 (4-state vocab lock). Reused by §1.D.1 BillCard
 * (B4.1 consumer) + §1.D.2 ClaimDetail (B4.2 consumer) so both surfaces derive
 * the same state from the same inputs — no drift.
 *
 * 4 states (worst → best UX surfacing):
 *   - `overcharge_no_draft` : audit found an overcharge; user hasn't drafted dispute yet
 *   - `overcharge_drafted`  : audit found an overcharge; user has a (non-cancelled) dispute
 *   - `needs_review`        : audit raised questions (tier-2/3 discrepancies OR low-confidence
 *                             findings) without confirmed overcharge — user input required
 *   - `clean`               : no findings, no review items, no overcharges
 *
 * Edge cases deliberately out of scope (deferred to B4 + Phase 3 per Phase 1 §1.D.1-C
 * Critical Pass): partial overcharge with partial dispute, dispute denied → revert,
 * bill paid before audit. When production data surfaces patterns, extend the state
 * machine; do not pre-emptively model speculative edges.
 */

export type BillState =
  | 'overcharge_drafted'
  | 'overcharge_no_draft'
  | 'needs_review'
  | 'clean';

/**
 * Audit finding shape (loose contract — callers pass whatever subset they have).
 *
 * `severity`: 'overcharge' = confirmed billing error eligible for recovery;
 *             'needs_review' = audit raised a question but couldn't auto-confirm.
 * `recovery_amount`: estimated dollars recoverable. Used only as overcharge
 *                    eligibility filter (`> 0`).
 * `confidence`: audit-rule confidence (0-1). Below 0.7 also routes to needs_review.
 */
export interface AuditFinding {
  severity?: 'overcharge' | 'needs_review' | string;
  recovery_amount?: number | null;
  confidence?: number | null;
}

/**
 * Discrepancy row from `claim_discrepancies`. Tier 2/3 unresolved discrepancies
 * count as `needs_review` signal per Phase 1 §1.D.1-C.
 */
export interface Discrepancy {
  tier?: number | null;
  status?: string | null;
}

/**
 * Dispute row. Status `'cancelled'` excludes the dispute from the drafted check;
 * any other status counts as a drafted (or otherwise-active) dispute.
 */
export interface Dispute {
  status?: string | null;
}

/**
 * Minimal claim shape — caller can pass either the full claim row or a thin
 * projection. Only `audit_findings` is read.
 */
export interface ClaimForBillState {
  audit_findings?: AuditFinding[] | null;
}

/**
 * Derive the 4-state BillState for a single bill.
 *
 * Branching order is deliberate:
 *   1. `needs_review` wins when uncertainty exists WITHOUT confirmed overcharge.
 *      If both uncertainty + overcharge exist, the overcharge dominates (the user
 *      cares about the recoverable dollars first; review questions get surfaced
 *      inside the overcharge flow).
 *   2. `overcharge_drafted` vs `overcharge_no_draft` is a simple dispute-existence
 *      check (any non-cancelled dispute counts as drafted).
 *   3. `clean` is the fallthrough — explicitly the absence of findings.
 *
 * Performance: O(n) over audit_findings + discrepancies + disputes — typically
 * 1-20 rows each in practice. No memoization layer; caller is expected to derive
 * at render or via useMemo if profiling shows hot path.
 */
export function deriveBillState(
  claim: ClaimForBillState,
  discrepancies: Discrepancy[],
  disputes: Dispute[],
): BillState {
  const findings = claim.audit_findings ?? [];

  const hasOvercharge = findings.some(
    (f) => f.severity === 'overcharge' && (f.recovery_amount ?? 0) > 0,
  );

  const hasUncertainty =
    findings.some(
      (f) =>
        f.severity === 'needs_review' || (f.confidence ?? 1) < 0.7,
    ) ||
    discrepancies.some(
      (d) => (d.tier === 2 || d.tier === 3) && d.status !== 'resolved',
    );

  const hasDraftedDispute = disputes.some((d) => d.status !== 'cancelled');

  if (hasUncertainty && !hasOvercharge) return 'needs_review';
  if (hasOvercharge && hasDraftedDispute) return 'overcharge_drafted';
  if (hasOvercharge && !hasDraftedDispute) return 'overcharge_no_draft';
  return 'clean';
}
