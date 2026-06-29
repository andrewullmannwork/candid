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
 * R3 step 3 — the condition-gated obligation registry that operationalizes the Evidence Disclosure
 * Rule ([[Candid_Data_Principles]] §1 + cost_share_v2 §18.10.A) as DATA, per-element × per-recipient,
 * instead of hardcoded per-template voice. Each element a letter could assert/demand/request resolves
 * to ONE voice via {@link selectObligationVoice}.
 *
 * `condition` references a SMALL FIXED predicate vocabulary ({@link ObligationPredicate}) — NOT a
 * general rules engine. Every predicate is UNKNOWN today (no NSA / contract / statute / rate signal
 * reaches the line yet), so the selector DEFAULTS to `voiceIfNot` (omit | fall_to_facts) = the
 * existing facts-based copy → byte-identical. Demands light up later (incr-5 §19 copy + the data that
 * flips a predicate). Byte-identity rests on the predicate-default, NOT the flag: the golden corpus
 * runs both `dispute_grounds_v1` OFF and ON variants and BOTH stay byte-identical.
 *
 * Separation of concerns: the catalog carries STRUCTURE (element key, obligated party, legal
 * authority, condition, the two voices). The legally-reviewed PROSE stays in code, versioned, keyed
 * by (element, voice) — selected by, not stored in, the catalog.
 */
export type ObligationPredicate =
  | "nsa_applicable" // the No Surprises Act applies to this line (OON balance-billing protection)
  | "contract_exists" // an in-network contract exists → a contracted rate is owed (§18.10.B)
  | "statute_verified" // a counsel-verified LEGAL_CITATION_REGISTRY entry exists (§4; unbuilt → null)
  | "rate_known"; // the allowed / contracted rate is known well enough to assert a number

/** The upgraded voice when the obligation is backed (predicate met + demands enabled). */
export type ObligationVoiceMet = "demand" | "raise" | "request";
/** The safe default when the obligation is not (yet) backed — never asserts what we can't prove. */
export type ObligationVoiceNot = "omit" | "fall_to_facts";
export type ObligationVoice = ObligationVoiceMet | ObligationVoiceNot;

/**
 * Who can satisfy an obligation element = the RENDER-ROUTING key for which recipient's letter the
 * clause appears in (shared by `ObligationElement.party` + `renderObligationClauses`'s recipient so
 * the equality match at obligation-render.ts can't drift). R3 step 5.4 — `provider_financial_assistance`
 * is the (inert) slot for the charity/FA fast-follow: no element uses it yet → renders nothing. It is
 * a render key, NOT a data entity (Pattern S: FA is a provider modifier at the data layer).
 */
export type ObligationParty = "insurer" | "provider" | "provider_financial_assistance";

export interface ObligationElement {
  /** Stable identity key (e.g. "nsa_protection") — also the prose-registry lookup key. */
  readonly element: string;
  /** Which party can satisfy it; the element renders only in that recipient's letter. */
  readonly party: ObligationParty;
  /** Human-readable legal authority (DATA, Rule #2), e.g. "No Surprises Act". Drives demand copy. */
  readonly authority: string;
  /** The predicate gating the upgrade; `null` = unconditionally certain (always `voiceIfMet`). */
  readonly condition: ObligationPredicate | null;
  readonly voiceIfMet: ObligationVoiceMet;
  readonly voiceIfNot: ObligationVoiceNot;
}

/**
 * Per-line predicate signals, read from the line at render time (`buildObligationContext`, Part 3 in
 * templates.ts). Every field is null / absent today → every predicate evaluates "unknown".
 */
export interface ObligationContext {
  readonly nsaApplicable?: boolean | null;
  readonly contractExists?: boolean | null;
  readonly statuteVerified?: boolean | null;
  readonly rateKnown?: boolean | null;
}

/** Evaluate one predicate against the context. `null` = unknown (the default-safe path). */
function evalObligationPredicate(p: ObligationPredicate, ctx: ObligationContext): boolean | null {
  switch (p) {
    case "nsa_applicable":
      return ctx.nsaApplicable ?? null;
    case "contract_exists":
      return ctx.contractExists ?? null;
    case "statute_verified":
      return ctx.statuteVerified ?? null;
    case "rate_known":
      return ctx.rateKnown ?? null;
    default: {
      // Exhaustiveness: adding a predicate without a case is a COMPILE error — keeps the
      // "1 enum member + 1 case" extensibility contract honest (the charter's referral/visit/
      // annual grounds add predicates here).
      const _never: never = p;
      return _never;
    }
  }
}

/**
 * Select an element's voice for one recipient. The Evidence Disclosure invariant lives here:
 *   - unconditional certain obligation (`condition === null`) → `voiceIfMet`;
 *   - demands disabled (the `dispute_grounds_v1` master switch OFF) → `voiceIfNot`;
 *   - predicate met → `voiceIfMet`; unknown / false → `voiceIfNot`.
 * Unknown defaults to `voiceIfNot` so we never assert / demand what we can't back.
 */
export function selectObligationVoice(
  element: ObligationElement,
  ctx: ObligationContext,
  demandsEnabled: boolean,
): ObligationVoice {
  if (element.condition === null) return element.voiceIfMet;
  if (!demandsEnabled) return element.voiceIfNot;
  return evalObligationPredicate(element.condition, ctx) === true
    ? element.voiceIfMet
    : element.voiceIfNot;
}

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
  /**
   * Condition-gated obligations (R3 step 3) — pure structure; voice via {@link selectObligationVoice},
   * prose stays versioned in code (templates.ts). Populated per ground in step-3 Part 2 (still `[]` here).
   */
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
// ----------------------------------------------------------------------------
// Obligation elements (R3 step 3) — the §18.10.A obligation table AS DATA.
// Each element = the thing a party is OBLIGATED to provide/do + who owes it + the
// legal authority + the predicate that backs it + the two voices. The registry
// owns OBLIGATIONS (provide the EOB, cite the provision, apply the contracted
// rate, prove the service); it does NOT own REMEDIES (refund / write-off / remove
// = recovery math, step 5). The legally-reviewed PROSE (keyed by element × voice)
// stays in templates.ts — SELECTED by, not stored in, the catalog.
//
// Two tiers: PER-GROUND elements attach to the ground that triggers them;
// CLAIM_LEVEL_OBLIGATIONS (itemized bill, EOB) are the baseline asks any dispute
// makes (they render in the closing tail, not a per-ground ask). Grounds whose
// only supporting ask IS the baseline itemized bill (duplicate / unbundling /
// unallocated_balance / benchmark) carry `[]` — their dollars are recovery math.
//
// THREE distinct "wrong rate" vectors — never conflate them:
//   • contracted_rate_apply (HERE, balance_billing): the insurer must APPLY the
//     negotiated in-network rate → party insurer, demand-apply, gated `contract_exists`.
//   • chargemaster ceiling (§18.10.G — FUTURE new ground, NOT modeled): the provider
//     billed above its OWN published list → party provider, voiceIfMet "raise" (never
//     assert), a NEW predicate, remedy up to total-drop.
//   • benchmark overcharge (`benchmark` ground): billed above a PUBLIC reference
//     (Medicare) → no obligated party → omit (obligationElements []).
// Adding chargemaster later = 1 ground + 1 element + 1 predicate + 1 detector. The
// rate DATA/comparison that makes such a predicate TRUE (per-service contracted /
// cash / published-list collection + comparison) is the Care flywheel build
// ([[care_network_rate_transparency]]) — a separate post-launch workstream that
// plugs in ONLY at buildObligationContext (templates.ts, Part 3). The registry is
// the letter-VOICE layer; the data layer is its source, not its concern.
// ----------------------------------------------------------------------------
export const DISPUTE_GROUND_CATALOG: Record<DisputeGroundType, DisputeGroundSpec> = {
  service_not_rendered: {
    order: 0,
    scoringClass: "service_not_rendered", // attestation override (evidence-resolver), not classifyDisputeType
    autoLetterType: "overcharge", // fromFindings empty → never reached by deriveFindingToLetter
    requestBucket: "attested",
    fromFindings: [],
    scope: "line",
    obligationElements: [
      { element: "proof_of_service_rendered", party: "provider", authority: "the provider's duty to substantiate a billed charge", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
    ],
  },
  balance_billing: {
    order: 1,
    scoringClass: "balance_billing",
    autoLetterType: "balance_billing",
    requestBucket: "balanceBilling",
    fromFindings: ["balance_billing"],
    scope: "line",
    obligationElements: [
      { element: "nsa_protection", party: "insurer", authority: "the No Surprises Act", condition: "nsa_applicable", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
      { element: "nsa_protection", party: "provider", authority: "the No Surprises Act", condition: "nsa_applicable", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
      // contracted-rate ≠ chargemaster (see header): the INSURER APPLIES the negotiated rate.
      { element: "contracted_rate_apply", party: "insurer", authority: "the plan's duty to process at the contracted rate (§18.10.B)", condition: "contract_exists", voiceIfMet: "demand", voiceIfNot: "omit" },
    ],
  },
  duplicate: {
    order: 2,
    scoringClass: "other", // duplicate-only line → classifyDisputeType falls through to "other"
    autoLetterType: "duplicate_charge",
    requestBucket: null, // no standalone request bucket today → fallback (post-R3 fix backlog)
    fromFindings: ["duplicate"],
    scope: "line_set",
    obligationElements: [], // dollars = recovery (step 5); evidence ask = CLAIM_LEVEL_OBLIGATIONS itemized bill
  },
  unbundling: {
    order: 3,
    scoringClass: "benchmark", // unbundling finding → classifyDisputeType benchmark branch
    autoLetterType: "overcharge",
    requestBucket: null,
    fromFindings: ["unbundling"],
    scope: "line_set",
    obligationElements: [], // as duplicate — the claim-level itemized bill is the supporting ask
  },
  coverage_contradiction: {
    order: 4,
    scoringClass: "coverage_contradiction",
    autoLetterType: "overcharge", // missing_adjustment→overcharge in FINDING_TO_LETTER (byte-identical)
    requestBucket: "coverage",
    fromFindings: ["insurance_underpayment", "missing_adjustment"],
    scope: "line",
    // plan_provision_basis only (the denial-reason demand). EOB is CLAIM_LEVEL (any insurer
    // dispute wants the adjudication). D3's coverage_assertion / produce_plan_document are
    // plan-presence-gated → deferred to incr-5 (a `plan_on_file` predicate), not seeded here.
    obligationElements: [
      { element: "plan_provision_basis", party: "insurer", authority: "29 CFR §2560.503-1 / ACA §2719 (full and fair review)", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
    ],
  },
  cost_share_misapplication: {
    order: 5,
    scoringClass: "cost_share_misapplication",
    autoLetterType: "overcharge", // zero_cost_share_overcharge not in FINDING_TO_LETTER → default overcharge
    requestBucket: "costShare",
    fromFindings: ["zero_cost_share_overcharge"],
    scope: "line",
    obligationElements: [
      { element: "deductible_oop_accumulator", party: "insurer", authority: "the insurer as adjudicator of the deductible / out-of-pocket accumulator", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
    ],
  },
  benchmark: {
    order: 6,
    scoringClass: "benchmark",
    autoLetterType: "overcharge",
    requestBucket: null,
    fromFindings: ["overcharge"],
    scope: "line",
    obligationElements: [], // §18.10.A: public reference rate (Medicare), no obligated party → omit
  },
  unallocated_balance: {
    order: 7,
    scoringClass: "other",
    autoLetterType: "overcharge", // unallocated_balance not in FINDING_TO_LETTER → default overcharge
    requestBucket: null,
    fromFindings: ["unallocated_balance"],
    scope: "claim",
    obligationElements: [], // claim-scope; evidence ask = CLAIM_LEVEL_OBLIGATIONS (itemized + EOB)
  },
  coding_peer: {
    order: 8,
    scoringClass: "coding_peer",
    autoLetterType: "overcharge", // fromFindings empty → never reached by deriveFindingToLetter
    requestBucket: "coding",
    fromFindings: [],
    scope: "line_set",
    obligationElements: [
      { element: "coding_review", party: "provider", authority: "coding-accuracy review (AMA CPT)", condition: null, voiceIfMet: "raise", voiceIfNot: "omit" },
    ],
  },
};

/**
 * Claim-level baseline obligations (R3 step 3) — apply to ANY dispute, not a single ground
 * (they render in the letter's closing "please also provide…" tail, not a per-ground ask).
 * §18.10.A lists itemized statement + EOB as standalone obligations. Consumed by incr-5's
 * demand-paragraph generation; the LIVE tail stays as-is (D3 `dispute_noplan_coverage_request_v1`-
 * gated) until incr-5 reconciles it — so this is seeded data, not a step-3 wiring.
 */
export const CLAIM_LEVEL_OBLIGATIONS: readonly ObligationElement[] = [
  { element: "itemized_statement", party: "provider", authority: "state itemized-bill statutes", condition: "statute_verified", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
  { element: "eob", party: "insurer", authority: "the insurer's duty to issue an explanation of benefits", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
];

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
