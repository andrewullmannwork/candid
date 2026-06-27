/**
 * R3 step 1 — DISPUTE_GROUND_CATALOG: the single source of truth for the dispute-letter
 * grounds taxonomy. Each ground's cross-cutting metadata (render order, scorer class, the
 * auto-detected letter type, request bucket, source findings, recovery scope) lives HERE so the
 * previously-scattered enumeration sites project FROM this one table instead of each carrying
 * its own drifting copy. Goal: adding a ground = ONE entry here + ONE detector (R3 step 2).
 *
 * SEEDED BYTE-IDENTICAL to today's behavior — the `catalog-projection-parity` fixture pins
 * every field against the original hardcoded values + the live classifier. The deliberate
 * behavior changes this catalog ENABLES (collapsing the two divergent classifiers
 * `classifyDisputeType` ↔ `groundsForLine`; giving `duplicate`/`unbundling`/`unallocated_balance`
 * their true spine tiers; the `overcharge`/`benchmark` naming reconcile) are SEPARATELY-GATED
 * steps AFTER this seed — NOT here. See [[unified_dispute_claim_engine_plan]] §2 R3 + §5.5.
 *
 * Live consumers wired in step 1: `FINDING_TO_LETTER` (disputes/index.ts) projects from
 * `fromFindings` + `autoLetterType` via `deriveFindingToLetter`; the `RequestBucket` type
 * (templates.ts) is centralized here. `classifyDisputeType`, `groundsForLine` and `SPINE_TIER`
 * stay byte-identical in step 1; the catalog's `scoringClass` / `requestBucket` / `scope`
 * document the mapping the classifier collapse (step 2) + the multi-charge model (step 5)
 * consume. `DisputeGroundType` (the key union) remains in `./dispute-grounds` (its domain home);
 * this file owns the per-ground METADATA.
 */
import type { DisputeGroundType } from "./dispute-grounds";
import type { DisputeTypeClass } from "./strength-scoring";
import type { FindingType, DisputeLetterType } from "../billing/types";

/** The request-section bucket a ground's ask renders into (templates.ts `buildRequestSection`). */
export type RequestBucket =
  | "attested"
  | "costShare"
  | "coverage"
  | "balanceBilling"
  | "coding";

/**
 * R3 step 3 replaces this with the condition-gated obligation element
 * (`{ element, party, authority, condition, voiceIfMet, voiceIfNot }`). Until then the field is
 * seeded `[]` on every ground (`never[]` accepts only the empty array → no premature shape).
 */
export type ObligationElement = never;

export interface DisputeGroundSpec {
  /** Strength / render order (the former private `TYPE_ORDER` in dispute-grounds.ts). */
  readonly order: number;
  /**
   * The scorer's class for a line dominated by this ground (`classifyDisputeType` output /
   * `SPINE_TIER` key). The per-ground probative tier is `SPINE_TIER[scoringClass]` — we do NOT
   * duplicate the tier here (it lives once, in strength-scoring's class→tier map). NOTE:
   * `service_not_rendered`'s class is the evidence-resolver attestation OVERRIDE, not a
   * `classifyDisputeType` branch; every other ground's class is `classifyDisputeType`-derived.
   */
  readonly scoringClass: DisputeTypeClass;
  /**
   * The auto-detected `DisputeLetterType` when a finding for this ground LEADS (the
   * `FINDING_TO_LETTER` value). This is the auto-detect default — NOT "the only template this
   * ground ever uses" (the insurer-appeal letter is chosen explicitly by the route). Almost
   * always `"overcharge"` (the generic letter); `duplicate`/`balance_billing` are the exceptions.
   */
  readonly autoLetterType: DisputeLetterType;
  /** The `buildRequestSection` bucket; `null` = no standalone ask (the line falls to the fallback). */
  readonly requestBucket: RequestBucket | null;
  /**
   * The audit finding type(s) `groundsForLine` maps INTO this ground. Empty for grounds raised
   * by a non-finding signal: `service_not_rendered` = user attestation, `coding_peer` = ≥2 peer
   * votes. Each `FindingType` belongs to at most one ground → `deriveFindingToLetter` is unambiguous.
   */
  readonly fromFindings: readonly FindingType[];
  /** The recovery aggregation scope (plan §3 multi-charge model; consumed in R3 step 5). */
  readonly scope: "line" | "line_set" | "claim";
  /** Condition-gated obligations (R3 step 3). Seeded `[]`. */
  readonly obligationElements: readonly ObligationElement[];
}

/**
 * The catalog. SEED VALUES REPRODUCE TODAY EXACTLY (incl. the quirks the post-R3 backlog fixes):
 *  - `benchmark` is the ground name for the `overcharge` finding (overcharge→benchmark).
 *  - `duplicate` / `unbundling` / `unallocated_balance` have NO scorer class of their own; today
 *    a line dominated by one collapses to `other` (→ inferred tier) or, for `unbundling`, to
 *    `benchmark` (the finding routes through `classifyDisputeType`'s benchmark branch). Pinned by
 *    the parity fixture; the "true tier" upgrade is a separately-gated post-R3 change.
 */
export const DISPUTE_GROUND_CATALOG: Record<DisputeGroundType, DisputeGroundSpec> = {
  service_not_rendered: {
    order: 0,
    scoringClass: "service_not_rendered", // attestation override (evidence-resolver), not classifyDisputeType
    autoLetterType: "overcharge", // fromFindings empty → never reached by deriveFindingToLetter
    requestBucket: "attested",
    fromFindings: [],
    scope: "line",
    obligationElements: [],
  },
  balance_billing: {
    order: 1,
    scoringClass: "balance_billing",
    autoLetterType: "balance_billing",
    requestBucket: "balanceBilling",
    fromFindings: ["balance_billing"],
    scope: "line",
    obligationElements: [],
  },
  duplicate: {
    order: 2,
    scoringClass: "other", // duplicate-only line → classifyDisputeType falls through to "other"
    autoLetterType: "duplicate_charge",
    requestBucket: null, // no standalone request bucket today → fallback (post-R3 fix backlog)
    fromFindings: ["duplicate"],
    scope: "line_set",
    obligationElements: [],
  },
  unbundling: {
    order: 3,
    scoringClass: "benchmark", // unbundling finding → classifyDisputeType benchmark branch
    autoLetterType: "overcharge",
    requestBucket: null,
    fromFindings: ["unbundling"],
    scope: "line_set",
    obligationElements: [],
  },
  coverage_contradiction: {
    order: 4,
    scoringClass: "coverage_contradiction",
    autoLetterType: "overcharge", // missing_adjustment→overcharge in FINDING_TO_LETTER (byte-identical)
    requestBucket: "coverage",
    fromFindings: ["insurance_underpayment", "missing_adjustment"],
    scope: "line",
    obligationElements: [],
  },
  cost_share_misapplication: {
    order: 5,
    scoringClass: "cost_share_misapplication",
    autoLetterType: "overcharge", // zero_cost_share_overcharge not in FINDING_TO_LETTER → default overcharge
    requestBucket: "costShare",
    fromFindings: ["zero_cost_share_overcharge"],
    scope: "line",
    obligationElements: [],
  },
  benchmark: {
    order: 6,
    scoringClass: "benchmark",
    autoLetterType: "overcharge",
    requestBucket: null,
    fromFindings: ["overcharge"],
    scope: "line",
    obligationElements: [],
  },
  unallocated_balance: {
    order: 7,
    scoringClass: "other",
    autoLetterType: "overcharge", // unallocated_balance not in FINDING_TO_LETTER → default overcharge
    requestBucket: null,
    fromFindings: ["unallocated_balance"],
    scope: "claim",
    obligationElements: [],
  },
  coding_peer: {
    order: 8,
    scoringClass: "coding_peer",
    autoLetterType: "overcharge", // fromFindings empty → never reached by deriveFindingToLetter
    requestBucket: "coding",
    fromFindings: [],
    scope: "line_set",
    obligationElements: [],
  },
};

/**
 * Project the finding→letter-type map from the catalog (replaces the hardcoded
 * `FINDING_TO_LETTER` in disputes/index.ts). A finding maps to its ground's `autoLetterType`;
 * findings raised by no ground (`upcoding` / `stale_claim` / the uncategorized pair) are absent
 * here and the consumer's existing `|| "overcharge"` default covers them — byte-identical for all
 * `FindingType`s, pinned by `catalog-projection-parity`.
 */
export function deriveFindingToLetter(): Partial<Record<FindingType, DisputeLetterType>> {
  const out: Partial<Record<FindingType, DisputeLetterType>> = {};
  for (const spec of Object.values(DISPUTE_GROUND_CATALOG)) {
    for (const f of spec.fromFindings) out[f] = spec.autoLetterType;
  }
  return out;
}
