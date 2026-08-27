/**
 * Dispute evidence resolver (Phase 4 of t_dispute_letter_redesign)
 *
 * Single source of truth for dispute evidence. Given a set of claim IDs (one
 * or multiple — T2.7 multi-bill dispute bundling), returns a structured
 * DisputeEvidence object used by:
 *   - letter body ("Why this service should be covered" block per line item)
 *   - Case File (every section shares this shape — no divergence)
 *   - UI hero + recipient card
 *
 * Graceful degradation:
 *   - No plan on file for the claim year → planBenefit null per line item.
 *   - No community data meeting k-anonymity threshold → communityEvidence null.
 *   - Insurer unknown → planEvidence.insurer defaults to provider name upstream.
 *
 * Internal-only provenance fields (`source`, `confidence`, k-anonymous counts)
 * gate rendering but are never displayed verbatim to insurance readers. See
 * Candid_Data_Patterns.md hard rule 4.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanContext } from "./plan-context";
import { extractPatternP8FromEntry, isCitationGrade } from "@/lib/parser/consumer-read";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import { findPeerCodesForSlug } from "./peer-code-engine";
import { resolveCanonicalSlugs } from "@/lib/parser/canonical-resolution";
import { normalizeCoinsurancePct, normalizeCoinsuranceDecimal, normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";
import type { ClaimLevelFindingMeta, NetworkTier } from "@/lib/billing/types";
import {
  resolveEffectiveClaimTotals,
  readUserTotalsSource,
  readUserPatientPaidOverride,
  applyUserPatientPaidOverride,
  type EffectiveClaimTotals,
} from "@/lib/claims/effective-totals";
import { resolveCoverageForLine, type CoverageDecision } from "@/lib/claims/coverage-decision";
import { coerceNetworkTier } from "@/lib/claims/cost-share-loader";
import { resolveStillOutstanding } from "@/lib/claims/recovery-math";
import {
  classifyDisputeType,
  deriveCiteGradeTier,
  deriveDollarAtStake,
  scopeAllows,
  type CompositionScopeSet,
  type DisputeTypeClass,
  type CiteGradeTier,
} from "./strength-scoring";
import { deriveFindingToGround, ALL_DISPUTE_GROUND_TYPES } from "./dispute-ground-catalog";
import type { DisputeGroundType } from "./dispute-grounds";
import {
  resolveSecondaryCoverage,
  loadPlanCoverageMeta,
  loadBillSlugMeta,
  loadSecondaryGate,
  loadCoverageRows,
  type SecondaryCoverage,
} from "@/lib/audit/coverage-loader";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { letterNeeds, normalizeLetterType } from "./letter-type";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import { K_ANON_THRESHOLDS } from "@/lib/care/interface";

/**
 * k-anonymity floors for community-derived statistics (S305).
 *
 * These were two local `= 5` literals here and a third in care/pricing-query,
 * three definitions of ONE rule (CLAUDE.md #5: minimum 5 users before showing a
 * statistic). They now point at the reviewed map in care/interface.ts.
 *
 * ⚠ Deliberately NOT flag-config-backed. That map carries "Changes require legal
 * review — these numbers determine when a community-derived statistic about a
 * named party is suppressed because the sample is too small to be fair"; making
 * it tunable from an admin screen would let someone move a legally-reviewed floor
 * without the review. One definition, still behind that gate.
 */
const K_ANON_PRICING = K_ANON_THRESHOLDS.unspecified_reference;

// S154 — helpers for the secondary (category) coverage match in the letter.
function humanizeSlug(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function secondaryCostShareLabel(cov: { copay: number | null; coinsurance: number | null }): string {
  if (cov.copay != null) return cov.copay === 0 ? "$0" : `$${cov.copay} copay`;
  if (cov.coinsurance != null) return `${normalizeCoinsurancePct(cov.coinsurance)}% coinsurance`;
  return "covered";
}
/**
 * S154 — build a PlanBenefitDetail from a verified secondary (category) match.
 * sbcExcerptVerified=false + covered + cost-share present → the letter renders a
 * Case-2 bullet (no verbatim blockquote), which is correct for an inferred-but-
 * user-confirmed coverage. `secondaryMatchedSlug` records the borrowed sibling.
 */
function buildSecondaryPlanBenefit(sec: SecondaryCoverage, planYear: number | null): PlanBenefitDetail {
  // R2 (S242) — a verified secondary (category) match IS covered by definition;
  // carry the shared decision so the route layer reads planStance uniformly.
  const coverageDecision = resolveCoverageForLine({ covered: true }, null);
  return {
    covered: true,
    copay: sec.coverage.copay,
    coinsurance: sec.coverage.coinsurance,
    source: sec.source,
    confidence: 0.6,
    citation: "",
    sbcExcerpt: null,
    sbcPage: null,
    sbcExcerptVerified: false,
    citationSource: null,
    sourcedFrom: "user_exact",
    sourcedFromYear: planYear,
    secondaryMatchedSlug: sec.matchedSlug,
    coverageDecision,
  };
}

/**
 * S293 (#6) — Case-2 benefit for a line EXACTLY covered on the claim's own plan
 * (per the shared loadPlanCoverageMeta map — the same map the needs panel and
 * claim page read) that Tier-1 nonetheless produced no benefit for (sub-floor
 * plan_covered_services row, or the letter's plan context differs from the
 * claim's plan). Built ONLY when the user recorded a human confirm on the line
 * (coverage_user_confirmed — the S292 aggregate "Looks right" fan-out or the
 * per-line Verify) — the human review is the precision oracle that upgrades a
 * value the platform already showed the user into a citable Case-2 statement
 * (bullet, never a verbatim quote: sbcExcerptVerified stays false).
 */
function buildExactMatchPlanBenefit(
  exact: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    // S294 — loadPlanCoverageMeta now carries this on BOTH the user-scoped and
    // the canonical-inherited branches, so the Case-2 borrow must carry it too.
    // Without it this builder would re-open the exact false-assertion path the
    // grounding gate in computeExpectedPatientCost closes.
    deductibleApplies?: boolean | null;
    source?: string | null;
  },
  planYear: number | null,
): PlanBenefitDetail {
  const coverageDecision = resolveCoverageForLine({ covered: exact.covered }, null);
  return {
    covered: coverageDecision.planStance !== "not_covered",
    copay: exact.copay,
    // loadPlanCoverageMeta's planCoverageFromRow already normalized to decimal 0-1.
    coinsurance: exact.coinsurance,
    deductibleApplies: exact.deductibleApplies ?? null,
    source: exact.source ?? "plan",
    confidence: 0.6,
    citation: "",
    sbcExcerpt: null,
    sbcPage: null,
    sbcExcerptVerified: false,
    citationSource: null,
    sourcedFrom: "user_exact",
    sourcedFromYear: planYear,
    coverageDecision,
  };
}

const K_ANON_THRESHOLD = K_ANON_THRESHOLDS.unspecified_reference;
const MIN_PLAN_BENEFIT_CONFIDENCE = 0.5;

/**
 * S110 Chunk C — single-point eligibility gate for archive auto-lookup
 * coverage. Per the lawyer-pass decision tree §3, the dispute letter only
 * cites the bill-year canonical archive ("Case C-archive") when the user
 * has confirmed they were on the same insurer in the bill year. Pattern 1
 * #2 ("no fabricated citations") demands this gate — without confirmation,
 * the archive could belong to an insurer the user has never been on.
 *
 * Manual bind via SearchCanonicalPlanModal (Chunk D) bypasses this gate:
 * the user explicitly selected the canonical, which IS the confirmation.
 *
 * Extracted as a single helper so future redesigns of the banner (different
 * state granularity, new flow paths) update the mapping in one place. Today
 * a coarse `yes` vote is sufficient; future banners may produce richer
 * intent without breaking this gate as long as the mapping stays here.
 */
export function isArchiveLookupEligible(
  userConfirmedSamePlan: "yes" | "no" | "not_sure" | null | undefined,
): boolean {
  return userConfirmedSamePlan === "yes";
}

export interface PlanBenefitDetail {
  covered: boolean;
  copay: number | null;
  coinsurance: number | null;
  /**
   * S294 — does this benefit's cost-share sit BEHIND the deductible?
   *
   * The letter's benefit model had no deductible concept at all, so
   * "No Charge AFTER deductible" (in_copay=0, in_deductible_applies=true) was
   * indistinguishable from "No Charge". See `computeExpectedPatientCost`.
   *
   * null/undefined = unknown (pre-S294 behavior).
   */
  deductibleApplies?: boolean | null;
  source: string;
  confidence: number;
  citation: string;
  sbcExcerpt: string | null;
  sbcPage: number | null;
  /**
   * Phase 4 Task 4-E: Pattern P-8 cite-grade verification status for the row's
   * primary cost field. Per Q-DR-4E-1 LOCK = (B), derived from in_copay's P-8
   * verification when copay is non-null, else from in_coinsurance's P-8.
   *
   * Drives the dispute letter blockquote 3-case logic per Q-DR-4E-2 LOCK:
   *   - Case 1 (sbcExcerptVerified === true): bullet + verbatim blockquote
   *   - Case 2 (false but covered + copay/coinsurance present): bullet, no blockquote
   *   - Case 3 (false + no certainty): drop bullet entirely
   *
   * Note: when Pattern P-8 verbatim is available and verified, we PREFER it over
   * the legacy sbcExcerpt column (mig 050 era) — the per-field excerpt is more
   * specific to the disputed cost than a row-level excerpt. Falls back to legacy
   * column when no P-8 data is present (legacy rows from before mig 056).
   */
  sbcExcerptVerified: boolean;
  /**
   * S74 Pillar 2 — where the cite-grade excerpt came from. Drives the
   * canonical-fallback transparency disclosure in EvidenceBlock so users
   * understand a citation may be sourced from another member's parse of
   * the same canonical plan (Pattern 1 #3 corroboration in action) rather
   * than from their own uploaded document. Distinct from `source` (which
   * is the row-level user provenance) — `citationSource` is the EXCERPT's
   * provenance specifically.
   *
   * Values:
   *   - 'user_doc'           → user's own row carries cite-grade P-8 verbatim
   *   - 'canonical_fallback' → user's row lacked P-8 verbatim; pulled from
   *                            canonical_haiku_extractions (S72 commit 4)
   *   - 'legacy_sbc_excerpt' → fell back to legacy mig 050 sbc_excerpt column
   *   - null                 → no excerpt populated (sbcExcerpt is null)
   */
  citationSource: "user_doc" | "canonical_fallback" | "legacy_sbc_excerpt" | null;
  /**
   * S109 PR #2 — which plan source produced this PlanBenefitDetail. Drives the
   * dispute-letter bullet copy variants (Case C-fallback says "My current plan
   * (year)" instead of "{planName} (year)"; Case C-archive says "Per {insurer}
   * {planName} {billYear} SBC (community-verified)"). Distinct from `source`
   * (row-level user provenance) and `citationSource` (excerpt provenance).
   *
   * Values:
   *   - 'user_exact'        → user's insurance_plans row for the bill's plan_year
   *   - 'canonical_archive' → bill-year canonical_plan_services bound via search
   *                            OR auto-resolved Pattern 2 identity match
   *   - 'user_fallback'     → user's insurance_plans row for a DIFFERENT plan
   *                            year (cited as proxy when same-plan confirmed)
   */
  sourcedFrom: "user_exact" | "canonical_archive" | "user_fallback";
  /**
   * S109 PR #2 — the plan year of the source that produced this benefit. Used
   * for the letter's year-mismatch disclosure ("My current plan (2025) specifies
   * ...; to the extent the 2023 plan differs..."). May be null when the
   * source plan's year is unknown (parser-side extraction gap).
   */
  sourcedFromYear: number | null;
  /**
   * S154 — when non-null, this benefit was borrowed from a same-category covered
   * sibling via the secondary match (e.g. annual_physical → preventive_care),
   * after the user verified it. Renders as a Case-2 bullet (no verbatim). Null
   * for direct exact-slug matches.
   */
  secondaryMatchedSlug?: string | null;
  /**
   * R2 (S242) — the shared CoverageDecision this benefit's coverage stance was
   * derived from (additive). The `covered` boolean above is now its LEGACY
   * PROJECTION (`planStance !== "not_covered"`). Carries planStance forward so the
   * route layer (R3) can detect `coverage_contradiction` (plan covered + insurer
   * denied) without re-deriving it. The insurer axis is null here — the row-mapper
   * has no claim line in scope; it merges where the adjudication lives. Optional:
   * only the two letter loaders (`buildPlanBenefitFromRow` /
   * `buildSecondaryPlanBenefit`) populate it today.
   */
  coverageDecision?: CoverageDecision;
}

export interface LineItemEvidence {
  lineItemId: string;
  billingCode: { value: string; type: string } | null;
  serviceSlug: string | null;
  serviceName: string;
  billedAmount: number;
  insurancePaid: number | null;
  patientOwes: number | null;
  /**
   * Block C2 (item 4) — what the patient has already PAID on this line
   * (claim_line_items.patient_paid_amount). Paired with patientOwes (still
   * billed/unpaid), this drives the refund (recovery) vs write-off
   * (forgiveness) split in the letter's request block. Null when the parser
   * didn't populate it (→ request degrades to "reverse the charge").
   */
  patientPaid: number | null;
  /**
   * Item B (R3 step 5.4 Phase 3) — the plan's allowed / contracted amount for this line
   * (claim_line_items.allowed_amount). Drives the contracted-rate ask. Null when the
   * bill/EOB had no per-line allowed column (the parser is conservative — common on
   * provider itemized bills) → the ask doesn't fire. Optional so the many fixture
   * literals that predate it stay valid (undefined === no signal).
   */
  allowedAmount?: number | null;
  /**
   * Item B — per-line network tier (claim_line_items.network_status, coerced via
   * coerceNetworkTier). Selects the contracted-rate voice: in_network/tiered → the
   * contract demand; out_of_network → suppress (no contract to invoke); null/unknown →
   * a factual allowed-amount request. Optional (see allowedAmount).
   */
  networkStatus?: NetworkTier | null;
  planBenefit: PlanBenefitDetail | null;
  expectedPatientCost: number | null;
  actualPatientCost: number | null;
  discrepancyAmount: number | null;
  discrepancyReason: string | null;
  /**
   * k-anonymous ( ≥ 5 claims) outcomes on the SAME canonical plan + plan_year
   * for this billing code. Enables the letter to cite "X other members on this
   * plan have been paid for this code" as persuasive evidence. Null when
   * canonical_plan_id is unknown, plan_year is unknown, or fewer than 5
   * community reports exist.
   */
  communityOutcome: {
    totalClaims: number;
    paidCount: number;
    deniedCount: number;
    avgPaidAmount: number | null;
    avgBilledAmount: number | null;
  } | null;
  /**
   * Sibling codes — other codes mapped to the same service_slug that have
   * PAID on this canonical plan + year. Signals that the denial is not a
   * category-wide exclusion. Null when there are no siblings with pay data
   * (or when canonical_plan_id is unknown).
   */
  siblingCodes: Array<{
    code: string;
    type: string;
    label: string;
    paidCount: number;
    totalClaims: number;
    avgPaidAmount: number | null;
  }> | null;
  /**
   * Community pricing benchmark from pricing_aggregates (Care data) —
   * median billed + sample size for this code in the patient's region.
   * Persuasive when the current bill is substantially above the community
   * median. Null when no region match or sample size < 5.
   */
  pricingBenchmark: {
    region: string | null;
    medianBilled: number | null;
    medianAllowed: number | null;
    avgPatientPaid: number | null;
    sampleSize: number;
  } | null;
  /**
   * Audit findings attached to this line item by the audit engine at claim
   * creation. Sources include Medicare benchmark comparison, duplicate
   * detection, upcoding flags, balance billing checks. Captured at parse
   * time and persisted in claim_line_items.metadata.auditFindings.
   */
  auditFindings: Array<{
    type: string;
    severity: string;
    title: string;
    /** §18 Stage 1 — the persisted finding description (persist.ts:278). Surfaced so the
     *  grounds builder can reproduce the letter's finding-detail block on the rerender path
     *  (the finding-level billedAmount is NOT persisted → the builder sources it from the
     *  line's billedAmount). Optional + additive → existing constructors/consumers ignore it. */
    description?: string | null;
    estimatedOvercharge: number;
    benchmarkAmount: number | null;
    benchmarkSource: string | null;
    /** R3 step 5.2 — the persisted finding id (claims/persist.ts) + the removal flag. The SET tier
     *  groups by findingId across the claim's lines + drops removed copies. Optional/additive. */
    findingId?: string;
    removed?: boolean;
    /** R3 step 5.3 — the persisted dismiss flag. Surfaced additively so the flag-gated recovery
     *  tiers (groundsForLine / SET pre-pass) + the detail block skip a user-dismissed finding; the
     *  OFF path never reads it → byte-identical. The CLAIM tier already filters f.dismissed. */
    dismissed?: boolean;
  }> | null;
  /**
   * Block C2.2 (S152) — true when an audit has actually RUN on this line (the
   * engine wrote an `auditFindings` key — even an empty array = "checked,
   * clean" — OR stamped `auditRerunAt`). Distinct from `auditFindings` being
   * non-empty: lets the `audit_findings_missing` gap fire only when no audit
   * has run, not when one ran and found nothing (a clean bill).
   */
  auditRan: boolean;
  /**
   * S74.6 D5 — corroborated peer codes for this line's service_slug. Derived
   * from `billing_code_identity` rows in `promotion_state IN ('corroborated',
   * 'admin_verified')`, excluding the contested line's own (code, type) row.
   * When the array has ≥ 2 entries (Q-S87-C7 letterEligible gate), the
   * dispute letter renders an alternative-code recommendation section per
   * Q-S87-D2 Option 1 copy. Null when the slug is unknown OR no corroborated
   * peers exist OR fewer than 2 peers cleared the gate.
   */
  peerCodes: Array<{
    code: string;
    codeType: string;
    confidence: number;
    promotionState: "corroborated" | "admin_verified";
  }> | null;
  /**
   * Block A — the EvidenceBundle normalization (plans/dispute_letter_overhaul.md
   * §1e). `disputeType` selects which signal is this line's spine; `citeGradeTier`
   * grades the spine quote; `dollarAtStake` is the §1a money weight w_i.
   * Populated once here (single producer) and consumed by computeDisputeStrength.
   */
  disputeType: DisputeTypeClass;
  citeGradeTier: CiteGradeTier;
  dollarAtStake: number;
  /**
   * Block C2 — true when the user has attested (under their own name) that this
   * service was not rendered. Forces `disputeType` to `service_not_rendered`
   * (documentary spine, §1d) and is the truthy signal `isSpinePresent` reads for
   * that type. Sourced from `dispute.metadata.serviceAttestedLineIds`, threaded by
   * the caller as `attestedLineItemIds`. Absent/false on every non-attested line.
   */
  serviceNotRenderedAttested?: boolean;
  /**
   * S154 — set when this line resolved to coverage via the SECONDARY (category)
   * match but the user hasn't verified it (not confirmed, not rejected).
   * `planBenefit` stays null (not cited); computeEvidenceGaps emits a
   * `service_coverage_verify` gap. Cleared once the user confirms (→ planBenefit
   * populated from the borrowed coverage) or rejects (→ excluded).
   */
  secondaryCoverageVerify?: {
    matchedSlug: string;
    matchedServiceName: string;
    costShareLabel: string;
    /**
     * S314 (Andrew) — what this ANSWER is worth, in dollars.
     *
     * The line is correctly withheld from the letter while the category match
     * is unconfirmed: we do not demand money on a guess. But the user was never
     * told what the open question costs them — the claim page promised $131.21
     * recoverable, the letter demanded $87.25, and nothing on screen explained
     * the $43.96 between them. The ask itself read "Add plan cost", an abstract
     * chore with no stated stakes, sitting behind a green checkmark that said it
     * was already handled.
     *
     * This is the same three calls the CONFIRMED branch above already makes;
     * the undecided branch simply never made them despite holding every input.
     *
     * ⚠ IT LIVES ON THE ASK, NEVER ON THE LINE. `ev.discrepancyAmount` stays
     * null while unconfirmed, which is what keeps this projection out of
     * `sumEvidenceTotals` — and therefore out of the letter's demand. Moving it
     * onto the line would make us demand money on an assumption, the exact
     * failure this whole design exists to prevent.
     *
     * Null when it cannot be computed (no actual patient cost on the line); the
     * copy drops the sentence rather than printing a placeholder.
     */
    projectedDiscrepancy: number | null;
  } | null;
}

/**
 * S314 (Andrew, from a letter paste) — the evidence totals, DERIVED from the
 * line evidence rather than accumulated while building it.
 *
 * THE BUG THIS REPLACES. `totalBilled` / `totalDiscrepancy` were running tallies
 * incremented inside the FIRST resolution pass. A SECOND pass
 * (`secondary_coverage_v2`) then goes back for the lines the exact-slug lookup
 * missed, matches them by category, and MUTATES `ev.discrepancyAmount` on those
 * same evidence objects — long after the tallies were finished. Nothing
 * re-summed them, so `totals.totalDiscrepancy` only ever knew about pass-1
 * lines, while the letter BODY (which reads `claims[].lineItemEvidence`) knew
 * about all of them.
 *
 * Live consequence: a PROD letter printed `Total Disputed: $33.25` in its
 * header above a body enumerating $33.25 + $39.12 + $14.88 = $87.25 — the two
 * missing lines being immunizations, which is exactly the class that resolves
 * by category rather than exact slug. Preventive care and immunizations make
 * this the common case, not a corner.
 *
 * WHY DERIVE RATHER THAN RE-SUM. Re-summing after pass 2 fixes today and
 * re-arms the identical trap for whoever adds a pass 3. The total is not a
 * fact of its own — it is a projection of the lines, and the lines are already
 * the single source of truth every other consumer reads (the body, persist's
 * `amount_disputed`, strength scoring). Computing it FROM them, once, after all
 * passes have run, makes the invariant structural: it cannot disagree with the
 * body, and a future mutation pass is included with nothing to remember.
 *
 * `totalBilled` is derived here too. It is not mutated by pass 2 *today*, so it
 * is not currently wrong — but it had the identical fragile shape, and fixing
 * the class is the point.
 *
 * ⚠ One deliberate behavior change: the old tallies incremented for EVERY
 * filtered line, including any whose `claim_id` matched no fetched claim (the
 * `if (claimEvidence)` push is conditional). Those lines could never reach the
 * body, so counting them was itself a defect; deriving from the claims drops
 * them.
 *
 * `lineItemCount` deliberately keeps its own meaning (how many lines were
 * examined) and is not derived here.
 */
export function sumEvidenceTotals(claims: ClaimEvidence[]): {
  totalBilled: number;
  totalDiscrepancy: number;
} {
  let totalBilled = 0;
  let totalDiscrepancy = 0;
  for (const c of claims) {
    for (const li of c.lineItemEvidence) {
      totalBilled += li.billedAmount;
      totalDiscrepancy += li.discrepancyAmount ?? 0;
    }
  }
  return { totalBilled, totalDiscrepancy };
}

export interface ClaimEvidence {
  claimId: string;
  dateOfService: string | null;
  providerName: string | null;
  totalBilled: number;
  planYear: number | null;
  lineItemEvidence: LineItemEvidence[];
  /**
   * S140 — cite-grade effective claim totals + per-field provenance. Used by
   * dispute templates for aggregate citations (replaces sum-of-nulls bug) and
   * citation framing prefix ("EOB summary records…" when header-sourced).
   */
  effectiveTotals: EffectiveClaimTotals;
  /**
   * Block A — per-bill data-trust flags mirrored onto claims.metadata by the
   * S142 PR4 bill-parser verifiers. Surfaced here (the resolver already fetches
   * claim.metadata) so computeDisputeStrength's data-trust GATE reads it without
   * a second query. header_reconciliation_failed → HARD STOP; signViolation →
   * WARN (§1a). Backend-owned contract — see workstream_coordination.md.
   */
  dataTrust: {
    headerReconciliationFailed: boolean;
    signViolation: boolean;
  };
  /**
   * R3 step 5.1 — claim-header findings (lineItems=[], e.g. `unallocated_balance`) persisted at
   * claim.metadata.auditSummary.claimLevelFindings. Surfaced RAW (incl. dismissed) so the dispute
   * recovery's CLAIM tier (resolveLetterRecovery) applies the !dismissed/actionable/scope policy.
   * Optional/additive: absent on synthetic evidence → the claim tier is simply empty.
   */
  claimFindings?: ClaimLevelFindingMeta[];
}

export interface PlanEvidenceDetail {
  planName: string | null;
  planYear: number | null;
  insurer: string | null;
  source: string;
  excerpts: Array<{ page: number | null; text: string }>;
}

export interface CommunityEvidence {
  sameCodeSamePlanCount: number;
  medianCopayPaid: number | null;
  pricingBenchmarks: {
    medicareRate: number | null;
    communityMedian: number | null;
  };
}

export interface NetworkEvidence {
  providerInNetwork: boolean | null;
  source: string;
}

export interface LegalBasisRef {
  statute: string;
  summary: string;
  appliesTo: string[];
}

export interface EvidenceGap {
  kind:
    | "plan_document_missing"
    | "plan_document_incomplete"
    | "line_items_unmapped"
    | "audit_findings_missing"
    /** S74 Pillar 3 — insurer appeals address missing (no row in insurer_catalog
     *  for the resolved plan's insurer, OR row exists with null appeals_address).
     *  Without an appeals address, an insurance-appeal letter cannot be mailed. */
    | "insurer_address_missing"
    /** S74 Pillar 3 — provider mailing address missing on the linked claim. Without
     *  it, an overcharge / balance billing / duplicate / itemized request letter
     *  has no recipient address. The UI surfaces a manual entry form. */
    | "provider_address_missing"
    /** Block C2 — provider address IS present (parsed from the bill) but the user
     *  hasn't confirmed it's correct. Optional "make it stronger" item: the UI
     *  shows a Confirm / Edit affordance mirroring the insurer verified-state. */
    | "provider_address_confirm"
    /** S301 — collector mailing address missing on a collections letter. The
     *  debt-validation letter's recipient block prints THIS address
     *  (templates.ts `buildCollectorRecipientBlock`), so its absence fails the
     *  MVDL floor exactly as a missing provider address does on a provider
     *  letter. Emitted only under `letter_requirements_v1`; before that flag the
     *  collections track was asked for a PROVIDER address it never prints. */
    | "collector_address_missing"
    /** S74 Pillar 3 — at least one planBenefit-row is not cite-grade
     *  (sbcExcerptVerified=false). The user can click Re-draft to re-parse
     *  un-searched plan-document sections and attempt to upgrade those rows
     *  to verbatim citations (CF-20 path). */
    | "cite_grade_incomplete"
    /** S109 PR #2 (Chunk B) — fallback-only case (bill year ≠ user's uploaded
     *  plan year) where the user hasn't yet confirmed whether they were on the
     *  same insurer in the bill year. Until confirmed, the letter renders Case
     *  D framing (no fallback-cite) per Pattern 1 #2. The primary UI is
     *  SamePlanConfirmBanner above the letter; EvidenceGaps surfaces it as a
     *  card too for parallelism with other gaps. */
    | "same_plan_unconfirmed"
    /** S111 D6 — user bound a canonical via PlanSearchModal but Candid's
     *  community library is missing cost-sharing for some/all bill line items
     *  on that canonical. Letter still cites the plan (Case C-archive) but
     *  can't render per-line copay/coinsurance bullets. Primary CTA opens the
     *  PlanSearchModal in upload mode so the user can graduate to user_exact
     *  via their own SBC; secondary action is dismiss-in-UI ("Continue without
     *  it"). Copy interpolates X/Y service counts + the missing service names. */
    | "bound_canonical_coverage_thin"
    /** S154 — a bill line resolved to coverage via the SECONDARY (category)
     *  match (no exact plan row) and the user hasn't verified the inferred match.
     *  Required gate: ServiceVerificationGateCard asks "does this match?" —
     *  Matches → cite it in the letter (confirm-coverage match); Doesn't → exclude
     *  (no_match). Until resolved the line carries no planBenefit (not cited). */
    | "service_coverage_verify";
  /** Short human-readable headline for the UI card. */
  title: string;
  /** One-line explanation of what adding this evidence unlocks. */
  description: string;
  /** Optional CTA label + href (upload, rerun audit, etc.). */
  ctaLabel?: string;
  ctaHref?: string;
  /**
   * S74 — number of unverified citations on this dispute for cite_grade_incomplete.
   * Drives the body copy ("3 of 5 citations…") and lets the UI route directly to
   * the Re-draft action instead of a navigation CTA.
   */
  unverifiedCount?: number;
  totalCount?: number;
  /** S154 service_coverage_verify — the claim + line_item to confirm/reject +
   *  human service names for the ServiceVerificationGateCard copy. */
  claimId?: string;
  lineItemId?: string;
  serviceName?: string;
  matchedServiceName?: string;
  costShareLabel?: string;
}

export interface DisputeEvidence {
  claims: ClaimEvidence[];
  totals: {
    claimCount: number;
    lineItemCount: number;
    totalBilled: number;
    totalDiscrepancy: number;
  };
  planEvidence: PlanEvidenceDetail | null;
  networkEvidence: NetworkEvidence | null;
  communityEvidence: CommunityEvidence | null;
  legalBasis: LegalBasisRef[];
  /**
   * Signals the letter would benefit from but we couldn't populate. UI
   * renders each as an actionable upload/refresh prompt.
   */
  gaps: EvidenceGap[];
  /**
   * Block A — dispute-level data-trust rollup (any-claim OR across §1a). The
   * data-trust GATE (computeDisputeStrength axis a) reads per-claim state; this
   * convenience aggregate drives the API payload + the letter-generation HARD
   * STOP. recon-failed precedence over sign-violation is applied by
   * evaluateDataTrust, not here.
   */
  dataTrust: {
    headerReconciliationFailed: boolean;
    signViolation: boolean;
  };
  /**
   * S326 (member_composition_v1) — the member's composition scope this evidence
   * was resolved UNDER, or null for the unscoped derivation (flag OFF, legacy
   * letters, and the composition step's own full-facts preview). Scope rides
   * the evidence object — the ONE carrier both generate and rerender pass
   * through the whole pipeline — so every consumer (classifier stamps,
   * recovery, detail blocks, templates, the panel) reads the same scope it
   * was built under and none can be forgotten (the S292 one-derivation rule).
   * Persisted as `disputes.metadata.member_selection`; rerender paths rebuild
   * it from the row (the attestedLineItemIds metadata→typed-param pattern).
   */
  compositionScope: MemberSelection | null;
}

/**
 * S326 — the member's composition record as ONE value: the grounds they
 * selected + the citations they adopted (registry keys). Persisted verbatim
 * as `disputes.metadata.member_selection`; stamped on the evidence so every
 * compose-layer consumer reads the same record it was built under.
 */
export interface MemberSelection {
  readonly grounds: readonly DisputeGroundType[];
  readonly adoptedCitations: readonly string[];
}

/**
 * S326 — parse a persisted `member_selection` metadata value back into a typed
 * MemberSelection (the metadata→typed-param pipeline's read half, shared by
 * every rerender-path caller so the shape check exists ONCE). Unknown ground
 * strings are dropped (a catalog rename must not silently widen scope);
 * null/absent/malformed → null (unscoped legacy behavior).
 */
export function memberSelectionFromMeta(
  meta: Record<string, unknown> | null | undefined,
): MemberSelection | null {
  const raw = meta?.member_selection as
    | { grounds?: unknown; adoptedCitations?: unknown }
    | null
    | undefined;
  if (!raw || !Array.isArray(raw.grounds)) return null;
  const validGrounds = new Set(Object.keys(FINDING_TO_GROUND_VALID));
  const grounds = raw.grounds.filter(
    (g): g is DisputeGroundType => typeof g === "string" && validGrounds.has(g),
  );
  if (grounds.length === 0) return null;
  const adoptedCitations = Array.isArray(raw.adoptedCitations)
    ? raw.adoptedCitations.filter((c): c is string => typeof c === "string")
    : [];
  return { grounds, adoptedCitations };
}

export async function resolveEvidence(
  supabase: SupabaseClient,
  params: {
    userId: string;
    claimIds: string[];
    lineItemIds?: string[];
    planContext: PlanContext | null;
    letterType?: string;
    /**
     * Persisted dispute id (when known). Used to build returnTo URLs on
     * EvidenceGaps upload CTAs so the user lands back on the correct
     * dispute after uploading. Falls back to the claim id if absent — that
     * still routes through /disputes but won't auto-refetch the right row.
     */
    disputeId?: string | null;
    /**
     * S109 PR #2 (Chunk B) — user's same-insurer confirmation for the bill
     * year. Read from dispute.metadata.userConfirmedSamePlan by the caller
     * and passed in. Drives whether the fallback plan's coverage is loaded
     * as a Case C-fallback proxy citation source ('yes') or treated as
     * unavailable ('no', 'not_sure', null) so the letter falls to Case D.
     */
    userConfirmedSamePlan?: "yes" | "no" | "not_sure" | null;
    /**
     * S110 Chunk D — explicit canonical the user bound via
     * SearchCanonicalPlanModal as their bill-year plan. Read from
     * dispute.metadata.canonicalPlanIdForBillYear. When set, this overrides
     * archive auto-lookup AND the user_fallback branch — manual selection is
     * the strongest signal (user explicitly chose this canonical as their
     * bill-year plan). Bypasses the userConfirmedSamePlan gate because the
     * bind action itself IS the confirmation.
     */
    canonicalPlanIdForBillYear?: string | null;
    /**
     * Block C2 — claim_line_item ids the user attested were NOT rendered. Read
     * from `dispute.metadata.serviceAttestedLineIds` by the caller (GET /
     * case-file / redraft) and passed in. Each matching line is reclassified to
     * `service_not_rendered` (documentary spine, Tier-1) in buildLineItemEvidence.
     * Same metadata→typed-param pipeline as `userConfirmedSamePlan`; absent on
     * first-draft generate calls (no attestation exists yet).
     */
    attestedLineItemIds?: string[];
    /**
     * S326 (member_composition_v1) — the member's composition record (selected
     * grounds + adopted citations). Read from `dispute.metadata.member_selection` by the
     * rerender-path callers (GET / redraft / escalate) and from the request
     * body by generate — the same metadata→typed-param pipeline as
     * `attestedLineItemIds`. When present, the line build filters findings and
     * signals so ONLY selected grounds can classify, price, or render;
     * null/absent → the unscoped (today's) derivation, byte-identical.
     */
    memberSelection?: MemberSelection | null;
  },
): Promise<DisputeEvidence> {
  const { userId, claimIds, lineItemIds, planContext, disputeId } = params;
  /**
   * S302 — NORMALIZED at the entry point, so a caller passing the raw
   * `dispute_outcomes.dispute_type` vocab can no longer produce wrong evidence.
   *
   * Every internal consumer wants the resolved type and none wants the raw one:
   * `resolveLegalBasis` switches on "insurance_appeal" (raw "internal_appeal"
   * returned NO legal basis, and `backedClaim` in the MVDL floor is partly
   * `legalBasis.length > 0`), and `computeEvidenceGaps`'s flag-OFF branch tests
   * `letterType === "insurance_appeal"` (raw vocab asked an appeal for the
   * PROVIDER's address and never for its appeals address). `letterNeeds`
   * already normalized internally; this brings the rest of the module in line.
   *
   * Found by auditing the call sites after the case-file drift: FOUR more were
   * passing raw vocab — redraft (×2), bind-canonical, and repin. Fixing them
   * one by one would leave the next caller free to make the same mistake, so
   * the fix belongs here, where it cannot be forgotten.
   */
  const letterType =
    params.letterType != null ? normalizeLetterType(params.letterType) : params.letterType;
  const userConfirmedSamePlan = params.userConfirmedSamePlan ?? null;
  const canonicalPlanIdForBillYear = params.canonicalPlanIdForBillYear ?? null;
  const attestedLineItemIds = new Set(params.attestedLineItemIds ?? []);
  // S326 — the member's composition record + the ground Set, built ONCE;
  // null = unscoped (today's derivation).
  const memberSelection = params.memberSelection ?? null;
  const compositionScope: CompositionScopeSet =
    memberSelection != null ? new Set(memberSelection.grounds) : null;

  if (claimIds.length === 0) {
    return emptyEvidence(planContext, letterType, memberSelection);
  }

  // Fetch claims + line items in parallel. Pull metadata on line items so
  // audit findings captured at claim creation can flow into the letter as
  // Medicare-benchmark / overcharge evidence.
  // B9-F09 — both reads go through the B1 layer (this resolver is a service-role
  // accessor; createServerClient bypasses RLS). claims: userScoped injects the
  // ownership filter (op-equivalent to the prior `.eq("user_id", userId)`).
  // claim_line_items has NO user_id, so it is scoped via selectOwnedChildren —
  // line items are fetched ONLY for the user's owned claims, by construction, so
  // a foreign claimId can no longer leak its lines into totals.totalDiscrepancy
  // (the prior unscoped `.in("claim_id", claimIds)` did).
  const [{ data: claims }, lineItems] = await Promise.all([
    userScoped(supabase, userId)
      .table("claims")
      // S140 fix-pass H4 — header total fields needed by resolveEffectiveClaimTotals
      // helper. Without them, helper sees null headers, defaults all provenance
      // to 'per_line_sum' (broken telemetry signal + wrong Case D citation
      // framing prefix).
      .select("id, date_of_service, total_billed, total_insurance_paid, total_insurance_adjusted, total_patient_paid, total_patient_responsibility, amount_still_outstanding, plan_year, metadata, insurance_plan_id")
      .in("id", claimIds),
    // S140 fix-pass H4 — per-line numeric fields needed by helper to compute
    // accurate per-line sums against claim header. patient_paid_amount +
    // insurance_adjusted_amount were missing, causing sums = 0 always.
    selectOwnedChildren(
      supabase,
      userId,
      "claim_line_items",
      claimIds,
      "id, claim_id, line_number, billing_code, billing_code_type, service_slug, description, billed_amount, allowed_amount, insurance_paid, insurance_adjusted_amount, patient_owes, patient_paid_amount, network_status, plan_year, metadata",
    ),
  ]);

  const claimRows = claims ?? [];
  const rawLineItems = lineItems;
  const filteredLineItems = lineItemIds && lineItemIds.length > 0
    ? rawLineItems.filter((li) => lineItemIds.includes(li.id))
    : rawLineItems;

  // S111 D1 refactor — source-priority candidate chain (first non-empty wins):
  //   Tier 1 (user_exact)        : user's exact-year plan from plan_covered_services
  //   Tier 2 (canonical_archive) : manual bind via PlanSearchModal — explicit
  //                                user selection of bill-year canonical;
  //                                bypasses userConfirmedSamePlan gate (the bind
  //                                IS the confirmation)
  //   Tier 3 (user_fallback)     : user's current plan as proxy citation (Case C-
  //                                fallback) — gated on userConfirmedSamePlan='yes'
  //
  // S111 D1 — auto-discovered archive (Pattern 2 year-shift) is **NO LONGER**
  // in this chain. It survives as a UI suggestion only
  // (`planContext.archiveCanonicalPlan` powers PlanSearchModal's auto-mode
  // best-match highlight). Pattern 1 #2 strict enforcement: citations require
  // explicit user binding, never silent auto-bind even with a high-confidence
  // year-shift match.
  //
  // Each PlanBenefitDetail tagged with `sourcedFrom` so the letter template
  // renders the right bullet copy variant per Subplan §3a.
  let coverageByServiceSlug: Map<string, PlanBenefitDetail>;
  let planYear: number | null = null;
  const archiveEligible = isArchiveLookupEligible(userConfirmedSamePlan);

  if (planContext?.plan) {
    // Tier 1 — user's exact-year plan.
    planYear = planContext.plan.planYear;
    coverageByServiceSlug = await loadCoverage(
      supabase,
      planContext.plan.id,
      "user_exact",
      planYear,
    );
    // S293 (#6 structural) — S290 canonical gap-fill PARITY for the letter path.
    // A search-selected plan (source='catalog_match') keeps its coverage on
    // canonical_plan_services, not user-scoped plan_covered_services. The card /
    // needs-panel path (loadPlanCoverageMeta) has inherited that canonical
    // coverage since S290, so the panel showed the user real cost-share values
    // ("canonical_inherited") — but THIS path read only plan_covered_services,
    // saw nothing, and the letter rendered zero clauses for services the user
    // had just confirmed (observed on dispute 80a705ac / claim 146b1b9f:
    // pcp_visit with a canonical $10 copay produced no SUPPORTING DETAIL).
    // Mirror the S290 rule exactly: ZERO user-scoped coverage rows + a linked
    // canonical → load the canonical coverage via the existing archive loader
    // (same confidence floor + canonical-haiku cite-grade cascade), tagged
    // 'canonical_archive' so the template renders the community-verified
    // framing — never presented as the user's own parsed document. Plans with
    // ANY user-scoped rows are untouched (docs stay authoritative, as in S290).
    if (coverageByServiceSlug.size === 0 && planContext.plan.canonicalPlanId) {
      const { data: pcsRows } = await loadCoverageRows(
        supabase,
        [planContext.plan.id],
        { citeGrade: false },
      );
      if ((pcsRows ?? []).length === 0) {
        coverageByServiceSlug = await loadCoverageFromCanonical(
          supabase,
          planContext.plan.canonicalPlanId,
          "canonical_archive",
          planYear,
        );
      }
    }
  } else if (canonicalPlanIdForBillYear) {
    // Tier 2 — manual canonical bind.
    planYear =
      planContext?.boundCanonicalPlan?.planYear ??
      planContext?.missingForYear ??
      null;
    coverageByServiceSlug = await loadCoverageFromCanonical(
      supabase,
      canonicalPlanIdForBillYear,
      "canonical_archive",
      planYear,
    );
  } else if (planContext?.fallbackPlan && archiveEligible) {
    // Tier 3 — user_fallback (cite current plan with year disclosed).
    planYear = planContext.fallbackPlan.planYear;
    coverageByServiceSlug = await loadCoverage(
      supabase,
      planContext.fallbackPlan.id,
      "user_fallback",
      planYear,
    );
  } else {
    coverageByServiceSlug = new Map<string, PlanBenefitDetail>();
  }

  // Load community outcomes (per billing code) for the canonical plan + year.
  // This is the "other claims that have been paid" signal. Requires canonical
  // plan + year to scope correctly. k-anonymity is enforced at render time.
  // (planYear declared above for loadCoverage source-year tagging.)
  //
  // S111 D8 — fall through to the manually-bound canonical when there's no
  // exact-year user plan. Without this, B5 fires: community/sibling/pricing
  // signals stay empty even though the user has bound a canonical that has
  // outcome data on it.
  const canonicalPlanId =
    planContext?.plan?.canonicalPlanId ??
    canonicalPlanIdForBillYear ??
    null;
  const codesList = filteredLineItems
    .filter((li) => li.billing_code && li.billing_code_type)
    .map((li) => ({ code: li.billing_code!, type: li.billing_code_type! }));

  const [communityByCode, siblingsByCode, pricingByCode, userRegion, codeSlugFallback] = await Promise.all([
    loadCommunityOutcomes(supabase, { canonicalPlanId, planYear, codes: codesList }),
    loadSiblingOutcomes(supabase, { canonicalPlanId, planYear, codes: codesList }),
    loadPricingBenchmarks(supabase, { userId, codes: codesList }),
    resolveUserRegion(supabase, userId),
    // Fallback: resolve service_slug from billing_code_mappings when claim
    // line items don't have a service_slug set (pre-T0.5 claims, or when
    // bill-parser mapping failed). Lets the plan-coverage lookup still hit.
    loadCodeToSlugFallback(supabase, codesList),
  ]);

  // S99 B5 — alias-aware coverage lookup. Pre-resolve every claim-line + code-
  // fallback slug to its canonical sibling so buildLineItemEvidence can match
  // against loadCoverage's canonical-keyed map even when the user's
  // plan_covered_services row sits on the alias slug and the line item on the
  // canonical (or vice versa). post-S95 reset this is identity (no aliases).
  const lineItemSlugs = new Set<string>();
  for (const li of filteredLineItems) {
    if (li.service_slug) lineItemSlugs.add(li.service_slug);
  }
  for (const fallback of codeSlugFallback.values()) {
    if (fallback) lineItemSlugs.add(fallback);
  }
  const lineItemCanonicalMap = lineItemSlugs.size > 0
    ? await resolveCanonicalSlugs(Array.from(lineItemSlugs), supabase)
    : new Map<string, string>();

  console.log("[evidence-resolver] signals loaded:", {
    canonicalPlanId,
    planYear,
    codesQueried: communityByCode.codesQueried,
    community: { rows: communityByCode.rowsReturned, passingKAnon: communityByCode.passingKAnon },
    siblings: { codesWithSiblings: siblingsByCode.size },
    pricing: { codesWithBenchmark: pricingByCode.size, region: userRegion },
    slugFallback: { codesWithSlug: codeSlugFallback.size },
  });

  // Build per-claim evidence.
  // S140 — pre-group filteredLineItems by claim_id so we can compute
  // effectiveTotals per claim in the same loop (avoids a second scan).
  // Helper accepts raw DB row shape via structural typing.
  const lineItemsByClaimId = new Map<string, typeof filteredLineItems>();
  for (const li of filteredLineItems) {
    const arr = lineItemsByClaimId.get(li.claim_id) ?? [];
    arr.push(li);
    lineItemsByClaimId.set(li.claim_id, arr);
  }

  const byClaim = new Map<string, ClaimEvidence>();
  for (const c of claimRows) {
    const claimLineItems = lineItemsByClaimId.get(c.id) ?? [];
    // S309 (Andrew's live catch: the letter's refund didn't follow his
    // amount-paid change) — the THIRD effective-totals site adopts the SAME
    // Z1.1d overlay the claim routes and the dispute basis already apply:
    // claims.metadata.userPatientPaid onto the header + prorated per-line,
    // BEFORE resolveEffectiveClaimTotals — so the letter's classifier,
    // recovery pools, and per-line citations all see the user's paid truth
    // the moment it changes. In-memory, like the other two sites; no-op when
    // the override is unset → byte-identical.
    {
      const ov = readUserPatientPaidOverride(c.metadata);
      if (ov != null) {
        applyUserPatientPaidOverride(
          c as { total_patient_paid?: number | null },
          claimLineItems as Array<{ billed_amount?: number | null; patient_paid_amount?: number | null }>,
          ov,
        );
      }
    }
    byClaim.set(c.id, {
      claimId: c.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dateOfService: (c as any).date_of_service ?? null,
      providerName:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((c.metadata as any)?.provider?.name as string | undefined) ?? null,
      totalBilled: Number(c.total_billed ?? 0),
      planYear: c.plan_year ?? null,
      lineItemEvidence: [],
      effectiveTotals: resolveEffectiveClaimTotals({
        claim: c,
        lineItems: claimLineItems,
        // The select above already pulls `metadata` (see the dataTrust read below).
        userTotalsSource: readUserTotalsSource(c.metadata),
      }),
      // Block A — read the S142 PR4 verdict flags mirrored onto claims.metadata
      // by claims/persist.ts. Absent key (clean bill) → false (pass).
      dataTrust: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headerReconciliationFailed: (c.metadata as any)?.header_reconciliation_failed === true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signViolation: (c.metadata as any)?.bill_parser_sign_violation === true,
      },
      // R3 step 5.1 — claim-header findings for the dispute recovery's claim tier (raw; the
      // recovery applies the !dismissed/actionable + catalog-scope policy).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimFindings: ((c.metadata as any)?.auditSummary?.claimLevelFindings as ClaimLevelFindingMeta[] | undefined) ?? [],
    });
  }

  // S74.6 D5 — batch-load corroborated peer codes for each distinct slug across
  // the bill. peer-code-engine queries `billing_code_identity` where slug matches
  // AND promotion_state IN ('corroborated','admin_verified'). Each line's
  // contested code is excluded per-call so we don't suggest re-coding to itself.
  const peerCodesBySlug = new Map<
    string,
    NonNullable<LineItemEvidence["peerCodes"]>
  >();
  const distinctSlugsForPeerLookup = new Set<string>();
  for (const li of filteredLineItems) {
    const slug =
      li.service_slug ??
      (li.billing_code && li.billing_code_type
        ? codeSlugFallback.get(`${li.billing_code_type}:${li.billing_code}`) ?? null
        : null);
    if (slug) distinctSlugsForPeerLookup.add(slug);
  }
  for (const slug of distinctSlugsForPeerLookup) {
    try {
      // Lookup excludes nothing here (multi-line dedupe); we exclude the
      // contested line's own (code, type) at render time via the gate.
      const peerResult = await findPeerCodesForSlug(supabase, {
        serviceSlug: slug,
        excludeCode: null,
        excludeCodeType: null,
      });
      if (peerResult.peers.length > 0) {
        peerCodesBySlug.set(
          slug,
          peerResult.peers.map((p) => ({
            code: p.code,
            codeType: p.codeType,
            confidence: p.confidence,
            promotionState: p.promotionState,
          })),
        );
      }
    } catch (err) {
      console.warn("[evidence-resolver] peer-code lookup failed for slug", slug, err);
    }
  }

  for (const li of filteredLineItems) {
    // S309 F12b — the claim's money context feeds the classifier's derived
    // actual-cost (shared proration when raw per-line money is null).
    const claimEvidence = byClaim.get(li.claim_id);
    const evidence = buildLineItemEvidence(
      li,
      coverageByServiceSlug,
      communityByCode.byCode,
      siblingsByCode,
      pricingByCode,
      codeSlugFallback,
      planContext,
      peerCodesBySlug,
      lineItemCanonicalMap,
      attestedLineItemIds.has(li.id),
      claimEvidence
        ? { totalBilled: claimEvidence.totalBilled, effectiveTotals: claimEvidence.effectiveTotals }
        : undefined,
      compositionScope,
    );
    if (claimEvidence) claimEvidence.lineItemEvidence.push(evidence);
  }

  const claimsArr = Array.from(byClaim.values());

  // S154 — secondary (category) coverage for lines the exact-slug lookup missed,
  // so the letter agrees with the home/detail pages (same shared resolver). Gated
  // by the user's per-line verification (claim_line_items.metadata; Pattern 1 #14):
  //   confirmed → cite it (Case-2 bullet, no verbatim);
  //   rejected  → exclude (no citation, no gate);
  //   undecided → emit a `service_coverage_verify` gate (no citation yet).
  if (await isFeatureEnabled("secondary_coverage_v2")) {
    const liById = new Map(filteredLineItems.map((li) => [li.id, li]));
    const planByClaim = new Map(
      claimRows.map((c) => [c.id as string, (c.insurance_plan_id as string | null) ?? null]),
    );
    const planYearByClaim = new Map(
      claimRows.map((c) => [c.id as string, (c.plan_year as number | null) ?? null]),
    );
    type Cand = {
      ev: LineItemEvidence;
      planId: string | null;
      planYear: number | null;
      meta: Record<string, unknown>;
    };
    const candidates: Cand[] = [];
    for (const c of claimsArr) {
      const planId = planByClaim.get(c.claimId) ?? null;
      const planYear = planYearByClaim.get(c.claimId) ?? null;
      for (const ev of c.lineItemEvidence) {
        if (ev.planBenefit || !ev.serviceSlug) continue;
        const meta =
          (liById.get(ev.lineItemId)?.metadata as Record<string, unknown> | undefined) ?? {};
        candidates.push({ ev, planId, planYear, meta });
      }
    }
    if (candidates.length > 0) {
      const planMetaByPlan = await loadPlanCoverageMeta(
        supabase,
        candidates.map((x) => x.planId),
      );
      const billSlugMeta = await loadBillSlugMeta(
        supabase,
        candidates.map((x) => x.ev.serviceSlug),
      );
      const gate = await loadSecondaryGate(supabase);
      for (const { ev, planId, planYear, meta } of candidates) {
        const slug = ev.serviceSlug as string;
        const bm = billSlugMeta.get(slug);
        if (!bm) continue;
        const planMeta = planId ? planMetaByPlan.get(planId) : undefined;
        // S154 fix — skip lines EXACTLY covered on the claim's own plan. The
        // dispute letter's plan context can differ from the claim's plan, so
        // ev.planBenefit (letter context) being null does NOT mean the service is
        // uncovered — it may be an exact match on the patient's actual plan. Don't
        // emit a secondary verify gate for an exactly-covered service.
        //
        // S293 (#6) — but "skip" must not mean "silence". This skip assumed
        // Tier-1 had already cited the exact match; when it hadn't (sub-floor
        // row / divergent plan context), a line the panel showed as covered —
        // and the user then CONFIRMED — produced no clause at all. If the user
        // recorded a confirm on such a line, adopt the exact-match value the
        // panel showed as a Case-2 citation (same recipe as the confirmed-
        // borrow branch below). Unconfirmed exact matches keep today's
        // behavior: skipped, no gate.
        const exact = planMeta?.coverageMap.get(slug);
        if (exact) {
          if (
            meta.coverage_user_confirmed === true &&
            exact.covered !== false &&
            (exact.copay != null || exact.coinsurance != null)
          ) {
            const pb = buildExactMatchPlanBenefit(exact, planYear);
            ev.planBenefit = pb;
            const expected = computeExpectedPatientCost(pb, ev.billedAmount);
            ev.expectedPatientCost = expected;
            if (expected != null && ev.actualPatientCost != null) {
              ev.discrepancyAmount = Math.max(0, ev.actualPatientCost - expected);
            }
          }
          continue;
        }
        const sec = resolveSecondaryCoverage(
          slug,
          bm,
          planMeta?.coveredMeta ?? [],
          planMeta?.acaCompliant ?? null,
          gate,
        );
        if (meta.coverage_user_rejected === true) continue; // user said "doesn't match" → exclude
        // S318 match+rate editor — the user's stored pick (coverage_user_matched_slug,
        // written with the confirm mark) outranks AND outlives the resolver's own
        // pick, so the letter cites the sibling the user actually chose — the same
        // lookup-with-fallback the money gate (resolveLinePrep) runs, which is what
        // keeps the screen and the letter agreeing on the chosen slug. Unknown slug
        // → resolver pick; resolver null + no usable pick → skip, as before.
        const userPick =
          meta.coverage_user_confirmed === true &&
          typeof meta.coverage_user_matched_slug === "string"
            ? ((planMeta?.coveredMeta ?? []).find(
                (c) => c.slug === meta.coverage_user_matched_slug,
              ) ?? null)
            : null;
        const effective = userPick
          ? {
              coverage: userPick.coverage,
              matchedSlug: userPick.slug,
              source: "secondary_match" as const,
              confidence: sec?.confidence ?? ("estimate" as const),
            }
          : sec;
        if (!effective) continue;
        if (meta.coverage_user_confirmed === true) {
          // "matches" → cite it (Case-2 bullet); recompute the cost-share delta.
          const pb = buildSecondaryPlanBenefit(effective, planYear);
          ev.planBenefit = pb;
          const expected = computeExpectedPatientCost(pb, ev.billedAmount);
          ev.expectedPatientCost = expected;
          if (expected != null && ev.actualPatientCost != null) {
            ev.discrepancyAmount = Math.max(0, ev.actualPatientCost - expected);
          }
        } else {
          // undecided → required verification gate (no citation until confirmed).
          //
          // S314 — price the question. Same derivation the confirmed branch
          // runs, computed WITHOUT writing planBenefit/discrepancyAmount, so
          // the line stays uncited and uncounted (see projectedDiscrepancy).
          const projectedBenefit = buildSecondaryPlanBenefit(effective, planYear);
          const projectedExpected = computeExpectedPatientCost(
            projectedBenefit,
            ev.billedAmount,
          );
          ev.secondaryCoverageVerify = {
            matchedSlug: effective.matchedSlug ?? "preventive_care",
            matchedServiceName: effective.matchedSlug
              ? humanizeSlug(effective.matchedSlug)
              : "preventive care (ACA $0)",
            costShareLabel: secondaryCostShareLabel(effective.coverage),
            projectedDiscrepancy:
              projectedExpected != null && ev.actualPatientCost != null
                ? Math.max(0, ev.actualPatientCost - projectedExpected)
                : null,
          };
        }
      }
    }
  }

  // Claim-level community aggregate: useful for the letter's opening
  // paragraph when individual line-item counts are all zero.
  const claimLevelCommunity = aggregateCommunity(claimsArr);
  const gaps = computeEvidenceGaps(
    claimsArr,
    planContext,
    params.claimIds,
    disputeId ?? null,
    letterType ?? null,
    userConfirmedSamePlan,
    canonicalPlanIdForBillYear,
    await isFeatureEnabled("letter_requirements_v1"),
  );

  // S314 — derived HERE, after every pass (including secondary-coverage) has
  // finished writing to the line evidence. See sumEvidenceTotals.
  const { totalBilled, totalDiscrepancy } = sumEvidenceTotals(claimsArr);

  return {
    claims: claimsArr,
    totals: {
      claimCount: claimsArr.length,
      lineItemCount: filteredLineItems.length,
      totalBilled,
      totalDiscrepancy,
    },
    planEvidence: planContext?.plan
      ? {
          planName: planContext.plan.planName,
          planYear: planContext.plan.planYear,
          insurer: planContext.insurer?.name ?? planContext.plan.insurerName,
          source: "sbc_parser",
          excerpts: [],
        }
      : null,
    networkEvidence: null,
    communityEvidence: claimLevelCommunity,
    legalBasis: resolveLegalBasis(letterType),
    gaps,
    // Block A — any-claim rollup of the per-claim data-trust flags.
    dataTrust: {
      headerReconciliationFailed: claimsArr.some(
        (c) => c.dataTrust.headerReconciliationFailed,
      ),
      signViolation: claimsArr.some((c) => c.dataTrust.signViolation),
    },
    // S326 — the member's composition record this evidence was resolved under.
    compositionScope: memberSelection,
  };
}

function computeEvidenceGaps(
  claims: ClaimEvidence[],
  planContext: PlanContext | null,
  claimIds: string[],
  disputeId: string | null,
  letterType: string | null,
  userConfirmedSamePlan: "yes" | "no" | "not_sure" | null,
  canonicalPlanIdForBillYear: string | null,
  /** `letter_requirements_v1` — OFF reproduces the pre-S301 binary exactly. */
  letterRequirementsOn: boolean,
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];

  // S154 — required verification gate per line that resolved via the secondary
  // (category) match but isn't user-confirmed yet. ServiceVerificationGateCard
  // renders Matches / Doesn't match; the marker is set in resolveEvidence's
  // post-pass and cleared once confirmed (→ cited) or rejected (→ excluded).
  for (const c of claims) {
    for (const ev of c.lineItemEvidence) {
      const v = ev.secondaryCoverageVerify;
      if (!v) continue;
      gaps.push({
        kind: "service_coverage_verify",
        title: "Verify this matches the correct service",
        description: `We matched "${ev.serviceName}" to your plan's ${v.matchedServiceName} coverage (${v.costShareLabel}) — related, but not an exact match. Confirm it's right and we'll cite it in your letter.`,
        claimId: c.claimId,
        lineItemId: ev.lineItemId,
        serviceName: ev.serviceName,
        matchedServiceName: v.matchedServiceName,
        costShareLabel: v.costShareLabel,
      });
    }
  }
  // Prefer the persisted dispute id for the returnTo URL so the user lands
  // back on the right /disputes?dispute=<id> view after uploading. Fall
  // back to the claim id only when no dispute is persisted yet (e.g.,
  // legacy ?letter= flow); the user can still navigate manually.
  const returnIdent = disputeId ?? claimIds[0] ?? null;
  const returnTo = returnIdent ? encodeURIComponent(`/disputes?dispute=${returnIdent}`) : "";

  const allLineItems = claims.flatMap((c) => c.lineItemEvidence);
  const anyPlanBenefit = allLineItems.some((li) => li.planBenefit);
  // Block C2.2 (S152) — "an audit has run on at least one line" (clean or not),
  // NOT "there are findings". Drives the audit_findings_missing gap so it fires
  // only when no audit has run — not on a clean bill, and it clears after a re-run.
  const anyAuditRan = allLineItems.some((li) => li.auditRan);
  const anyUnmapped = allLineItems.some((li) => !li.serviceSlug && li.billingCode);

  const planYearForUpload = planContext?.missingForYear ?? planContext?.plan?.planYear ?? null;
  const uploadHref = planYearForUpload
    ? `/upload?planYear=${planYearForUpload}${returnTo ? `&returnTo=${returnTo}` : ""}`
    : `/upload${returnTo ? `?returnTo=${returnTo}` : ""}`;

  if (!planContext?.plan && !canonicalPlanIdForBillYear) {
    // S109 — differentiate "no plan at all" from "plan on file but for a
    // different year than this bill." The fallbackPlan branch fires when the
    // user has uploaded an insurance plan but its plan_year (or coverage
    // window) doesn't cover this bill's date_of_service. Saying "upload your
    // insurance plan" in that case is misleading — they did.
    //
    // S111 D1/B1 — suppress entirely when canonicalPlanIdForBillYear is set:
    // the user has explicitly bound a bill-year canonical, so prompting them
    // to upload contradicts that decision. If the bound canonical's coverage
    // doesn't match the bill's codes, the D6 bound_canonical_coverage_thin
    // gap emits a more accurate upload prompt below.
    //
    // Three sub-cases:
    //   (a) fallback exists + we know the missing year → "Upload your <year> plan"
    //       (fallback.planYear may be null when the parser failed to extract
    //       it; the title only needs missingYear, description adapts)
    //   (b) fallback exists but no missing year (claim has no plan_year and
    //       date_of_service couldn't be parsed) → "Upload the plan that was
    //       active for this bill"
    //   (c) no fallback at all → generic "Upload your insurance plan"
    const fallback = planContext?.fallbackPlan ?? null;
    const missingYear = planContext?.missingForYear ?? null;
    if (fallback && missingYear != null) {
      const fbYearClause = fallback.planYear != null
        ? `Your ${fallback.planYear} plan is on file.`
        : "You have an insurance plan on file.";
      gaps.push({
        kind: "plan_document_missing",
        title: `Upload your ${missingYear} plan`,
        description:
          `${fbYearClause} This bill is from ${missingYear} — plan terms change year to year, so uploading your ${missingYear} plan lets the letter cite that year's specific copay / coinsurance terms.`,
        ctaLabel: "Upload plan document",
        ctaHref: uploadHref,
      });
    } else if (fallback) {
      gaps.push({
        kind: "plan_document_missing",
        title: "Upload the plan that was active for this bill",
        description:
          "You have an insurance plan on file, but we couldn't determine which plan year applied to this bill. Upload the plan that was active when this service was rendered so the letter can cite the right terms.",
        ctaLabel: "Upload plan document",
        ctaHref: uploadHref,
      });
    } else {
      gaps.push({
        kind: "plan_document_missing",
        title: "Upload your insurance plan",
        description:
          "The letter can cite your plan's specific copay / coinsurance terms and SBC page references once your plan document is on file.",
        ctaLabel: "Upload plan document",
        ctaHref: uploadHref,
      });
    }
  } else if (planContext?.plan && !anyPlanBenefit) {
    // S111 — constrain to the "user has plan, parser missed codes" case. The
    // bound-canonical thin-coverage case is handled by D6
    // bound_canonical_coverage_thin below, which has tailored copy that
    // names the bound canonical.
    gaps.push({
      kind: "plan_document_incomplete",
      title: "Add pages from your plan document",
      description:
        "We have your plan on file but couldn't match any of this bill's codes to a covered service. Upload additional pages (or a more complete SBC) to add copay citations per line item.",
      ctaLabel: "Upload more plan pages",
      ctaHref: uploadHref,
    });
  }

  // ── Recipient address (S301) — ONE derivation, keyed on the letter ────────
  //
  // `needs.recipientAddress` is the machine image of the letter composer's own
  // recipient decision (index.ts), so the address we ask for is always the
  // address the letter prints. Before this, the two questions were answered
  // independently: `insurer_address_missing` fired ONLY for insurance_appeal
  // and `provider_address_missing` fired for everything that ISN'T
  // insurance_appeal — so an insurer-directed external review was asked for a
  // provider address and never for its appeals address, and a collector letter
  // was asked for the clinic's address instead of the collector's.
  //
  // Flag OFF → the legacy binary below, byte-identical.
  const needs = letterNeeds(letterType);
  const wantsInsurerAddress = letterRequirementsOn
    ? needs.recipientAddress === "insurer_appeals_address"
    : letterType === "insurance_appeal";
  const wantsProviderAddress = letterRequirementsOn
    ? needs.recipientAddress === "provider_address"
    : letterType !== "insurance_appeal" && letterType !== null;
  const wantsCollectorAddress =
    letterRequirementsOn && needs.recipientAddress === "collector_address";

  const insurerAddressMissing =
    !!planContext?.plan &&
    (!planContext.insurer || !planContext.insurer.appealsAddress);
  if (insurerAddressMissing && wantsInsurerAddress) {
    gaps.push({
      kind: "insurer_address_missing",
      title: "We don't have your insurer's appeals address on file",
      description:
        "Your insurance appeal needs a mailing address. Upload a more complete plan document so the appeals address can be extracted, or contact your insurer directly to confirm where appeals go.",
      ctaLabel: "Upload plan document",
      ctaHref: uploadHref,
    });
  }

  // S301 — collector mailing address. The letter prints it; without it the
  // recipient block renders the agency NAME alone (templates.ts
  // `buildCollectorRecipientBlock` joins name + address, skipping nulls).
  // Reads the SAME planContext field every other consumer reads — no per-caller
  // threading, so a caller cannot forget to supply it and silently suppress the gap.
  const collectorAddressOnFile = !!planContext?.collectorContact?.address;
  if (wantsCollectorAddress && !collectorAddressOnFile) {
    gaps.push({
      kind: "collector_address_missing",
      title: "Where do we mail the collector?",
      description:
        "The collection agency's mailing address — it's printed on the notice they sent you. Your debt validation letter goes to this address.",
      // No ctaHref — the UI renders an inline form that POSTs to
      // /api/disputes/[disputeId]/collector-contact.
    });
  }

  // S74 Pillar 3 — provider mailing address missing on the linked claim.
  const providerAddressMissing =
    !!planContext &&
    (!planContext.providerContact || !planContext.providerContact.address);
  const goesToProvider = wantsProviderAddress;
  if (providerAddressMissing && goesToProvider) {
    gaps.push({
      kind: "provider_address_missing",
      title: "Where did you get care?",
      description:
        "We have your insurer's appeals address. Now add the provider's billing address — the clinic or hospital that sent the bill — so we can address them too. Find it on your bill or the provider's website; it'll save for this claim and any future disputes on it.",
      // Intentionally no ctaHref — the UI renders an inline form that POSTs to
      // /api/disputes/[disputeId]/provider-contact.
    });
  } else if (
    goesToProvider &&
    !!planContext?.providerContact?.address &&
    !planContext.providerContact.confirmedAt
  ) {
    // Block C2 — address is present (parsed) but unconfirmed. Optional confirm
    // step mirroring the insurer verified-state; the UI shows Confirm / Edit.
    gaps.push({
      kind: "provider_address_confirm",
      title: "Confirm where you got care",
      description:
        "We pulled this provider's billing address from your bill. Confirm it's right — or edit it — so the letter reaches the correct office.",
      // No ctaHref — the UI renders an inline Confirm / Edit affordance that
      // POSTs to /api/disputes/[disputeId]/provider-contact.
    });
  }

  // S74 Pillar 3 — cite-grade incomplete. Count planBenefit-bearing rows
  // whose sbcExcerptVerified is false. The Re-draft CTA on the toolbar runs
  // CF-20 re-parse-on-flag (gated by consumer_read_filter_v1) which can
  // upgrade those rows to verbatim citations.
  const planBenefitRows = allLineItems.filter((li) => li.planBenefit);
  const unverifiedCiteGrade = planBenefitRows.filter(
    (li) => li.planBenefit && !li.planBenefit.sbcExcerptVerified,
  );
  if (unverifiedCiteGrade.length > 0 && planBenefitRows.length > 0) {
    const unverified = unverifiedCiteGrade.length;
    const total = planBenefitRows.length;
    gaps.push({
      kind: "cite_grade_incomplete",
      title: `${unverified} of ${total} citation${total === 1 ? "" : "s"} ${unverified === 1 ? "isn't" : "aren't"} verbatim-verified yet`,
      description:
        "Verified citations include the verbatim plan-document quote that strengthens the letter. Re-draft to re-parse un-searched plan sections and attempt to upgrade these rows — the cost is bounded by per-plan daily caps.",
      ctaLabel: "Re-draft letter",
      // Intentionally no ctaHref — the UI wires this kind to the existing
      // POST /api/disputes/[disputeId]/redraft endpoint via the toolbar's
      // Re-draft button.
      unverifiedCount: unverified,
      totalCount: total,
    });
  }

  // S109 PR #2 (Chunk B) — same-plan-confirmation gap. Fires when the user
  // has a fallback plan on file (different year than the bill) and hasn't
  // yet confirmed whether they were on the same insurer in the bill year.
  // SamePlanConfirmBanner above the letter is the primary surface; this
  // panel card is the parallel "Strengthen this letter" affordance.
  //
  // S110 Chunk D — suppress when the user has already bound a canonical
  // via SearchCanonicalPlanModal. Manual bind IS the confirmation; banner
  // is redundant once a canonical is selected for the bill year.
  if (
    !planContext?.plan &&
    planContext?.fallbackPlan &&
    planContext.missingForYear != null &&
    userConfirmedSamePlan == null &&
    !canonicalPlanIdForBillYear
  ) {
    const fbYearText = planContext.fallbackPlan.planYear != null
      ? `your ${planContext.fallbackPlan.planYear} plan`
      : "your current plan";
    gaps.push({
      kind: "same_plan_unconfirmed",
      title: `Were you on the same insurer in ${planContext.missingForYear}?`,
      description:
        `We don't have your ${planContext.missingForYear} plan on file, but we do have ${fbYearText}. If you had the same insurer then, this letter can cite the current plan's terms as a proxy and ask the insurer to prove any year-over-year differences. If you switched insurers, those terms don't apply.`,
      // CTA wired by SamePlanConfirmBanner above the letter — no ctaHref.
    });
  }

  if (!anyAuditRan) {
    gaps.push({
      kind: "audit_findings_missing",
      title: "No audit findings attached",
      description:
        // S109 — drop the Medicare-benchmark reference. CMS PPL integration is
        // wired but per-code benchmark coverage isn't broad enough yet to
        // promise users Medicare comparisons. The audit rules that actually
        // fire today are plan-coverage mismatches (copay/coinsurance vs
        // billed), duplicate-charge detection, and balance-billing flags —
        // describe those instead so the CTA matches what re-run produces.
        "Re-run the audit against this bill to flag plan-coverage mismatches, duplicate charges, and balance-billing patterns. Findings strengthen the letter with concrete dispute reasons cited to your plan.",
      ctaLabel: "Re-run audit",
      // Intentionally no ctaHref — the UI wires this kind to an inline
      // POST /api/disputes/[disputeId]/rerun-audit instead of a navigation.
    });
  }

  if (anyUnmapped) {
    gaps.push({
      kind: "line_items_unmapped",
      title: "Some line items aren't categorized",
      description:
        "A few codes on this bill don't have a known category yet — the letter still cites the code + EOB math, but plan-coverage matching needs a category.",
    });
  }

  // S111 D6 — bound canonical coverage thin. Fires when the user has
  // explicitly bound a bill-year canonical (canonicalPlanIdForBillYear set,
  // no exact-year user plan) AND the bound canonical's coverage doesn't
  // match all of this bill's billable line items. Letter still cites the
  // canonical via Case C-archive closing, but missing planBenefit rows mean
  // per-line copay/coinsurance bullets can't render. Approved copy from
  // Subplan §3c verbatim. Primary CTA opens PlanSearchModal in upload mode
  // (wired in disputes/page.tsx via onUploadInModal); we don't emit
  // ctaHref because the route is in-modal, not a navigation.
  if (
    canonicalPlanIdForBillYear &&
    !planContext?.plan &&
    planContext?.boundCanonicalPlan
  ) {
    const billableItems = allLineItems.filter((li) => li.billingCode);
    const missingItems = billableItems.filter((li) => !li.planBenefit);
    if (missingItems.length > 0 && billableItems.length > 0) {
      const Y = billableItems.length;
      const X = missingItems.length;
      const bound = planContext.boundCanonicalPlan;
      const billYear =
        bound.planYear ?? planContext.missingForYear ?? null;
      const insurer = bound.insurerName ?? "your insurer";
      const planName = bound.planName ?? "your plan";

      const allMissing = X === Y;
      const xOfYClause =
        allMissing && Y === 1
          ? "for this bill's services"
          : allMissing
            ? `for ${Y} of ${Y} services`
            : `for ${X} of ${Y} services`;

      // Dedup + preserve order. ServiceName is reliably set by buildLineItemEvidence
      // even for unmapped items (falls back to "Service" / code). Empty-string
      // names are dropped to keep the comma list clean.
      const missingNamesSet = new Set<string>();
      const missingNames: string[] = [];
      for (const li of missingItems) {
        if (li.serviceName && !missingNamesSet.has(li.serviceName)) {
          missingNamesSet.add(li.serviceName);
          missingNames.push(li.serviceName);
        }
      }
      const serviceNameClause =
        missingNames.length === 0
          ? "these services"
          : missingNames.length === 1
            ? missingNames[0]
            : missingNames.length === 2
              ? `${missingNames[0]} and ${missingNames[1]}`
              : `${missingNames.slice(0, -1).join(", ")}, and ${missingNames[missingNames.length - 1]}`;

      const yearSegment = billYear != null ? `${billYear} ` : "";
      const ctaYearSegment = billYear != null ? `${billYear} ` : "";

      gaps.push({
        kind: "bound_canonical_coverage_thin",
        title: `Got the plan — but we're light on details ${xOfYClause}.`,
        description: `We linked your ${yearSegment}${insurer} ${planName}, but Candid's community library is missing cost-sharing for ${serviceNameClause} on this exact plan. Your letter still cites the plan, but uploading your ${yearSegment}SBC would let us cite the actual copay and coinsurance.`,
        ctaLabel: `Upload my ${ctaYearSegment}plan`,
        // Intentionally no ctaHref — the EvidenceGaps UI wires this kind to
        // open PlanSearchModal in upload mode rather than navigating to /upload.
        unverifiedCount: X,
        totalCount: Y,
      });
    }
  }

  return gaps;
}

function emptyEvidence(
  planContext: PlanContext | null,
  letterType?: string,
  memberSelection?: MemberSelection | null,
): DisputeEvidence {
  return {
    claims: [],
    totals: { claimCount: 0, lineItemCount: 0, totalBilled: 0, totalDiscrepancy: 0 },
    planEvidence: planContext?.plan
      ? {
          planName: planContext.plan.planName,
          planYear: planContext.plan.planYear,
          insurer: planContext.insurer?.name ?? planContext.plan.insurerName,
          source: "sbc_parser",
          excerpts: [],
        }
      : null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: resolveLegalBasis(letterType),
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    compositionScope: memberSelection ?? null,
  };
}

// ============================================================================
// R1a (S240) — shared coverage-read helpers, extracted from loadCoverage +
// loadCoverageFromCanonical (they were ~90% identical). Parity-gated in
// scripts/calibration/fixtures/cost-share-v2/coverage-loader-parity.ts.
// ============================================================================

/** One coverage row in the shape buildPlanBenefitFromRow consumes. `sbc_excerpt` /
 *  `sbc_page` are user-table (plan_covered_services) only — pass null for canonical. */
export interface CoverageRowForBenefit {
  covered: boolean | null;
  in_copay: number | null;
  in_coinsurance: number | null;
  /**
   * S294 — optional so no caller breaks; populated by both real callers. See
   * `computeExpectedPatientCost` for why the letter needs it: without it, a
   * "$0 AFTER deductible" benefit read as a flat $0 expected cost and the
   * letter asserted the entire bill as a discrepancy.
   */
  in_deductible_applies?: boolean | null;
  source: string | null;
  confidence: number | null;
  sbc_excerpt: string | null;
  sbc_page: number | null;
  field_provenance: Record<string, FieldProvenanceEntry> | null;
  slug: string;
  name: string;
}

/** Pre-loaded, per-plan cite-grade context shared across every row of one load. */
export interface CiteGradeContext {
  citeGradeGateOn: boolean;
  canonicalCiteGradeBySlug: Map<string, { sourceExcerpt: string; sourceSectionHint: string }>;
  coverageCanonicalMap: Map<string, string>;
}

/** Table-specific knobs — the only things the two loaders differed on per row. */
export interface PlanBenefitRowOpts {
  sourceTag: PlanBenefitDetail["sourcedFrom"];
  sourceYear: number | null;
  sourceDefault: string;
  buildCitation: (name: string, sbcPage: number | null) => string;
}

/**
 * The shared per-row cite-grade mapper: the A3 identity axis + the P-8 → canonical-
 * haiku → legacy-sbc excerpt cascade + alias keying. PURE. Returns null when the row
 * falls below the confidence floor (the prior loops' `continue`). Both loaders fetch
 * rows for their table and call this; byte-identical to the prior inline loops
 * (coverage-loader-parity.ts).
 */
export function buildPlanBenefitFromRow(
  row: CoverageRowForBenefit,
  ctx: CiteGradeContext,
  opts: PlanBenefitRowOpts,
): { canonicalSlug: string; detail: PlanBenefitDetail } | null {
  const confidence = row.confidence ?? 0.5;
  if (confidence < MIN_PLAN_BENEFIT_CONFIDENCE) return null;

  // Pattern P-8 cite-grade for the row's primary cost field (in_copay when present, else in_coinsurance).
  const primaryField = row.in_copay !== null ? "in_copay" : "in_coinsurance";
  const p8Entry = row.field_provenance?.[primaryField];
  const p8 = extractPatternP8FromEntry(p8Entry);
  // A3: identity axis — unconfirmed synonym cache-win → referenced, not cited.
  const identityInferred =
    ctx.citeGradeGateOn &&
    p8Entry?.resolution_source != null &&
    p8Entry?.identity_confirmed !== true;
  const userRowCiteGrade = isCitationGrade(p8, { identityInferred });
  // Fall back to canonical_haiku_extractions when the row lacks its own cite-grade P-8.
  const canonicalFallback = !userRowCiteGrade
    ? ctx.canonicalCiteGradeBySlug.get(row.slug) ?? null
    : null;
  // A3: inferred identity → null the excerpt so the letter references but never quotes.
  const preferredExcerpt = identityInferred
    ? null
    : p8?.source_excerpt ?? canonicalFallback?.sourceExcerpt ?? row.sbc_excerpt ?? null;
  const sbcExcerptVerified = !identityInferred && (userRowCiteGrade || canonicalFallback !== null);
  const citationSource: PlanBenefitDetail["citationSource"] = identityInferred
    ? null
    : userRowCiteGrade
    ? "user_doc"
    : canonicalFallback !== null
    ? "canonical_fallback"
    : row.sbc_excerpt
    ? "legacy_sbc_excerpt"
    : null;

  // S99 B5 — key by canonical sibling (identity when no aliases exist).
  const canonicalSlug = ctx.coverageCanonicalMap.get(row.slug) ?? row.slug;
  // R2 (S242) — the shared coverage decision for this row; planStance feeds the
  // legacy `covered` projection below and is carried forward on the detail.
  const coverageDecision = resolveCoverageForLine({ covered: row.covered }, null);
  return {
    canonicalSlug,
    detail: {
      covered: coverageDecision.planStance !== "not_covered",
      copay: row.in_copay,
      // R1c (S240) — normalize to decimal [0,1] at load (same as planCoverageFromRow on the
      // card path) so PlanBenefitDetail.coinsurance is a consistent decimal contract. The
      // display/dollar/fingerprint consumers already re-normalize idempotently → render-neutral.
      coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance),
      deductibleApplies: row.in_deductible_applies ?? null,
      source: row.source ?? opts.sourceDefault,
      confidence,
      citation: opts.buildCitation(row.name, row.sbc_page),
      sbcExcerpt: preferredExcerpt,
      sbcPage: row.sbc_page ?? null,
      sbcExcerptVerified,
      citationSource,
      sourcedFrom: opts.sourceTag,
      sourcedFromYear: opts.sourceYear,
      coverageDecision,
    },
  };
}

/**
 * Pre-load cite-grade excerpts from canonical_haiku_extractions for a canonical plan
 * (verified + section-verified only = cite-grade per Pattern P-8). Most-recent wins.
 * Shared by both loaders (was duplicated verbatim). Empty map when no canonical id.
 */
async function loadCanonicalCiteGradeBySlug(
  supabase: SupabaseClient,
  canonicalPlanId: string | null,
): Promise<Map<string, { sourceExcerpt: string; sourceSectionHint: string }>> {
  const out = new Map<string, { sourceExcerpt: string; sourceSectionHint: string }>();
  if (!canonicalPlanId) return out;
  const { data: extractions } = await supabase
    .from("canonical_haiku_extractions")
    .select("service_slug, source_excerpt, source_section_hint, created_at")
    .eq("canonical_plan_id", canonicalPlanId)
    .eq("field_name", "services_cost_sharing_row")
    .eq("source_excerpt_verified", "verified")
    .eq("source_section_verified", true)
    .order("created_at", { ascending: false });
  if (extractions) {
    for (const ext of extractions as Array<{
      service_slug: string | null;
      source_excerpt: string | null;
      source_section_hint: string | null;
    }>) {
      if (!ext.service_slug || !ext.source_excerpt) continue;
      if (!out.has(ext.service_slug)) {
        out.set(ext.service_slug, {
          sourceExcerpt: ext.source_excerpt,
          sourceSectionHint: ext.source_section_hint ?? "",
        });
      }
    }
  }
  return out;
}

export async function loadCoverage(
  supabase: SupabaseClient,
  insurancePlanId: string | null,
  sourceTag: PlanBenefitDetail["sourcedFrom"] = "user_exact",
  sourceYear: number | null = null,
): Promise<Map<string, PlanBenefitDetail>> {
  // S99 B5 — keyed by CANONICAL slug (resolved via service_catalog.concept_id).
  // Pre-S95 / no-aliases state: canonical === raw (no-op). Post-alias-promotion:
  // alias rows are normalized to their canonical for lookup, so buildLineItemEvidence
  // matches on canonical regardless of which slug the user's row sits on.
  const byServiceSlug = new Map<string, PlanBenefitDetail>();
  if (!insurancePlanId) return byServiceSlug;

  // A3 (cite-grade gate): when ON, a row whose identity was inferred by an unconfirmed synonym
  // cache-win (field_provenance.{field}.resolution_source set) is referenced, NOT verbatim-cited —
  // the excerpt backs the ORIGINAL label, not the remapped concept. The loop below nulls the
  // excerpt for such rows so the dispute-letter blockquote can't render. Flag OFF → no-op.
  const citeGradeGateOn = await isFeatureEnabled("cite_grade_gate_v1");

  // S72 commit 4: pre-load canonical_haiku_extractions cite-grade citations for this
  // plan's canonical. Used as fallback in the loop below when user's own row's
  // Pattern P-8 field_provenance lacks excerpt (smart-skip case post-CF-40 v3).
  // One query per loadCoverage call (cheap; ~30 services per plan typical) → O(1)
  // lookup per row in the loop. Closes CF-20 cite-grade gap for smart-skipped users.
  const { data: planRow } = await supabase
    .from("insurance_plans")
    .select("canonical_plan_id")
    .eq("id", insurancePlanId)
    .maybeSingle();
  const canonicalPlanId = (planRow?.canonical_plan_id as string | null | undefined) ?? null;

  const canonicalCiteGradeBySlug = await loadCanonicalCiteGradeBySlug(supabase, canonicalPlanId);

  // plan_covered_services rows; service_catalog.slug is the natural join key.
  // sbc_excerpt/sbc_page exist after migration 050 (Phase 4.5).
  // field_provenance JSONB exists after migration 056 (Phase 3 — per-field P-8 storage).
  // Use optional chaining / default-null to stay compatible with rows that predate
  // either migration.
  const { data: rows } = await loadCoverageRows(supabase, [insurancePlanId], { citeGrade: true });

  if (!rows) return byServiceSlug;

  // S99 B5 — pre-resolve canonical sibling for every raw slug emitted by this
  // plan's coverage rows. Single batched query against service_catalog; falls
  // through to identity when no aliases exist.
  const rawSlugsForCanonical: string[] = [];
  for (const r of rows) {
    const cat = (r as { service_catalog: { slug?: string } | { slug?: string }[] }).service_catalog;
    const slug = Array.isArray(cat) ? cat[0]?.slug : cat?.slug;
    if (slug) rawSlugsForCanonical.push(slug);
  }
  const coverageCanonicalMap =
    rawSlugsForCanonical.length > 0
      ? await resolveCanonicalSlugs(rawSlugsForCanonical, supabase)
      : new Map<string, string>();

  const citeCtx: CiteGradeContext = { citeGradeGateOn, canonicalCiteGradeBySlug, coverageCanonicalMap };
  for (const r of rows as unknown as Array<{
    covered: boolean | null;
    in_copay: number | null;
    in_coinsurance: number | null;
    in_deductible_applies: boolean | null;
    source: string | null;
    confidence: number | null;
    sbc_excerpt: string | null;
    sbc_page: number | null;
    field_provenance: Record<string, FieldProvenanceEntry> | null;
    service_catalog: { slug: string; name: string } | Array<{ slug: string; name: string }>;
  }>) {
    const cat = Array.isArray(r.service_catalog) ? r.service_catalog[0] : r.service_catalog;
    if (!cat?.slug) continue;
    const built = buildPlanBenefitFromRow(
      {
        covered: r.covered,
        in_copay: r.in_copay,
        in_coinsurance: r.in_coinsurance,
        // S294 — already in COVERAGE_BASE_SELECT; it was read and dropped here.
        // The user-doc path carries the same false-assertion risk as canonical.
        in_deductible_applies: r.in_deductible_applies,
        source: r.source,
        confidence: r.confidence,
        sbc_excerpt: r.sbc_excerpt,
        sbc_page: r.sbc_page,
        field_provenance: r.field_provenance,
        slug: cat.slug,
        name: cat.name,
      },
      citeCtx,
      {
        sourceTag,
        sourceYear,
        sourceDefault: "unknown",
        buildCitation: (name, page) => `Plan SBC${page ? `, page ${page}` : ""} — ${name}`,
      },
    );
    if (built) byServiceSlug.set(built.canonicalSlug, built.detail);
  }

  return byServiceSlug;
}

/**
 * S110 Chunk C — load coverage from canonical_plan_services for an archive
 * canonical (either Pattern 2 auto-lookup OR manual bind via Chunk D).
 *
 * Mirrors loadCoverage but reads canonical-scoped coverage instead of user-
 * scoped. Key differences:
 *   - Primary table is canonical_plan_services (not plan_covered_services).
 *   - canonical_plan_services has no sbc_excerpt/sbc_page columns (those
 *     live on plan_covered_services from SBC parser); cite-grade excerpts
 *     come exclusively from canonical_haiku_extractions for this path.
 *   - citationSource is always 'canonical_fallback' when an excerpt exists
 *     (the excerpt was contributed by ANOTHER member who parsed this
 *     canonical), else null. Matches Subplan §3a row 4.
 *
 * Caller is responsible for tagging sourceTag='canonical_archive' for both
 * manual bind and auto-lookup paths — the letter template renders the same
 * "Per {insurer} {planName} {year} SBC (community-verified)" framing in
 * both cases.
 */
export async function loadCoverageFromCanonical(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  sourceTag: PlanBenefitDetail["sourcedFrom"],
  sourceYear: number | null,
): Promise<Map<string, PlanBenefitDetail>> {
  const byServiceSlug = new Map<string, PlanBenefitDetail>();

  // A3 (cite-grade gate): symmetric with loadCoverage — an inferred-identity canonical row is
  // referenced, not verbatim-cited (its excerpt is keyed on the uncertain remapped slug). Dormant
  // pre-Group-B (today's canonical seed carries no resolution_source); forward-correct. Flag OFF → no-op.
  const citeGradeGateOn = await isFeatureEnabled("cite_grade_gate_v1");

  // Pre-load cite-grade excerpts from canonical_haiku_extractions for this canonical.
  const canonicalCiteGradeBySlug = await loadCanonicalCiteGradeBySlug(supabase, canonicalPlanId);

  // R1b-canon (S240) — canonical_plan_services has NO service_catalog FK, so the prior
  // `service_catalog!inner(slug, name)` embedded join ERRORED → rows null → this returned an
  // EMPTY coverage map (the canonical-archive letter path was silently broken since S110).
  // Fix: read the rows, then resolve display names via a separate service_catalog lookup —
  // the working pattern loadCanonicalCoverageMeta uses. Behavior change: empty → real coverage.
  const { data: rows } = await supabase
    .from("canonical_plan_services")
    // S294 — `in_deductible_applies` added. Its absence is why this path could
    // read "No Charge after deductible" as a flat $0 expected cost.
    .select(
      "service_slug, covered, in_copay, in_coinsurance, in_deductible_applies, source, confidence, field_provenance",
    )
    .eq("canonical_plan_id", canonicalPlanId);

  if (!rows) return byServiceSlug;

  const canonRows = rows as unknown as Array<{
    service_slug: string | null;
    covered: boolean | null;
    in_copay: number | null;
    in_coinsurance: number | null;
    in_deductible_applies: boolean | null;
    source: string | null;
    confidence: number | null;
    field_provenance: Record<string, FieldProvenanceEntry> | null;
  }>;

  // Display names for the slugs (no FK → separate lookup; mirrors loadCanonicalCoverageMeta).
  const slugList = Array.from(new Set(canonRows.map((r) => r.service_slug).filter(Boolean) as string[]));
  const nameBySlug = new Map<string, string>();
  if (slugList.length > 0) {
    const { data: catalog } = await supabase.from("service_catalog").select("slug, name").in("slug", slugList);
    for (const c of catalog ?? []) nameBySlug.set(c.slug as string, (c.name as string | null) ?? (c.slug as string));
  }

  // Pre-resolve canonical sibling for alias normalization (identity when no aliases exist).
  const coverageCanonicalMap =
    slugList.length > 0
      ? await resolveCanonicalSlugs(slugList, supabase)
      : new Map<string, string>();

  const citeCtx: CiteGradeContext = { citeGradeGateOn, canonicalCiteGradeBySlug, coverageCanonicalMap };
  for (const r of canonRows) {
    if (!r.service_slug) continue;
    // canonical_plan_services has no sbc_excerpt / sbc_page columns → pass null (the cascade
    // degrades to the canonical-haiku excerpt, and the legacy branch never fires).
    const built = buildPlanBenefitFromRow(
      {
        covered: r.covered,
        in_copay: r.in_copay,
        in_coinsurance: r.in_coinsurance,
        in_deductible_applies: r.in_deductible_applies,
        source: r.source,
        confidence: r.confidence,
        sbc_excerpt: null,
        sbc_page: null,
        field_provenance: r.field_provenance,
        slug: r.service_slug,
        name: nameBySlug.get(r.service_slug) ?? r.service_slug,
      },
      citeCtx,
      {
        sourceTag,
        sourceYear,
        sourceDefault: "canonical",
        buildCitation: (name) => `Summary of Benefits and Coverage — ${name}`,
      },
    );
    if (built) byServiceSlug.set(built.canonicalSlug, built.detail);
  }

  return byServiceSlug;
}

interface CommunityOutcomeRow {
  totalClaims: number;
  paidCount: number;
  deniedCount: number;
  avgPaidAmount: number | null;
  avgBilledAmount: number | null;
}

async function loadCommunityOutcomes(
  supabase: SupabaseClient,
  params: {
    canonicalPlanId: string | null;
    planYear: number | null;
    codes: Array<{ code: string; type: string }>;
  },
): Promise<{ byCode: Map<string, CommunityOutcomeRow>; codesQueried: number; rowsReturned: number; passingKAnon: number }> {
  const byCode = new Map<string, CommunityOutcomeRow>();
  if (!params.canonicalPlanId || params.codes.length === 0) {
    return { byCode, codesQueried: params.codes.length, rowsReturned: 0, passingKAnon: 0 };
  }

  // Dedup codes before hitting the DB.
  const uniqueKeys = new Set(params.codes.map((c) => `${c.type}:${c.code}`));
  const codesArr = Array.from(uniqueKeys).map((k) => {
    const [type, code] = k.split(":");
    return { type, code };
  });

  const query = supabase
    .from("billing_code_plan_outcomes")
    .select("billing_code, billing_code_type, total_claims, paid_count, denied_count, avg_paid_amount, avg_billed_amount, plan_year")
    .eq("canonical_plan_id", params.canonicalPlanId)
    .in("billing_code", codesArr.map((c) => c.code));

  const { data: rows, error } = params.planYear != null
    ? await query.eq("plan_year", params.planYear)
    : await query.is("plan_year", null);

  if (error) {
    console.error("[evidence-resolver] billing_code_plan_outcomes query failed:", error);
    return { byCode, codesQueried: codesArr.length, rowsReturned: 0, passingKAnon: 0 };
  }

  let passing = 0;
  for (const r of rows ?? []) {
    // Enforce k-anonymity at render time: omit aggregates where total_claims < 5.
    const total = Number(r.total_claims ?? 0);
    if (total < 5) continue;
    byCode.set(`${r.billing_code_type}:${r.billing_code}`, {
      totalClaims: total,
      paidCount: Number(r.paid_count ?? 0),
      deniedCount: Number(r.denied_count ?? 0),
      avgPaidAmount: r.avg_paid_amount != null ? Number(r.avg_paid_amount) : null,
      avgBilledAmount: r.avg_billed_amount != null ? Number(r.avg_billed_amount) : null,
    });
    passing++;
  }

  return {
    byCode,
    codesQueried: codesArr.length,
    rowsReturned: rows?.length ?? 0,
    passingKAnon: passing,
  };
}

function aggregateCommunity(claims: ClaimEvidence[]): CommunityEvidence | null {
  let totalPaid = 0;
  let sumClaimCounts = 0;
  const paidAmounts: number[] = [];
  for (const c of claims) {
    for (const li of c.lineItemEvidence) {
      if (!li.communityOutcome) continue;
      sumClaimCounts += li.communityOutcome.totalClaims;
      totalPaid += li.communityOutcome.paidCount;
      if (li.communityOutcome.avgPaidAmount != null) paidAmounts.push(li.communityOutcome.avgPaidAmount);
    }
  }
  if (sumClaimCounts === 0) return null;
  const medianCopayPaid = paidAmounts.length > 0
    ? paidAmounts.slice().sort((a, b) => a - b)[Math.floor(paidAmounts.length / 2)]
    : null;
  return {
    sameCodeSamePlanCount: sumClaimCounts,
    medianCopayPaid,
    pricingBenchmarks: { medicareRate: null, communityMedian: null },
  };
}

async function loadSiblingOutcomes(
  supabase: SupabaseClient,
  params: {
    canonicalPlanId: string | null;
    planYear: number | null;
    codes: Array<{ code: string; type: string }>;
  },
): Promise<Map<string, NonNullable<LineItemEvidence["siblingCodes"]>>> {
  const byCode = new Map<string, NonNullable<LineItemEvidence["siblingCodes"]>>();
  if (!params.canonicalPlanId || params.codes.length === 0) return byCode;

  // 1. Lookup each code's service_slug.
  const codeKeys = params.codes.map((c) => `${c.type}:${c.code}`);
  const { data: mappings } = await supabase
    .from("billing_code_mappings")
    .select("billing_code, billing_code_type, service_slug")
    .in("billing_code", params.codes.map((c) => c.code));

  const codeToSlug = new Map<string, string>();
  const slugToCodes = new Map<string, Set<string>>();
  for (const m of mappings ?? []) {
    const key = `${m.billing_code_type}:${m.billing_code}`;
    codeToSlug.set(key, m.service_slug);
    const set = slugToCodes.get(m.service_slug) ?? new Set<string>();
    set.add(key);
    slugToCodes.set(m.service_slug, set);
  }

  // 2. For each slug present among claim codes, find OTHER codes mapped to it
  //    so we can query their outcomes on this plan.
  const siblingCandidates = new Map<string, string[]>();
  for (const originKey of codeKeys) {
    const slug = codeToSlug.get(originKey);
    if (!slug) continue;
    const all = slugToCodes.get(slug);
    if (!all) continue;
    const others = Array.from(all).filter((k) => k !== originKey);
    if (others.length > 0) siblingCandidates.set(originKey, others);
  }
  if (siblingCandidates.size === 0) return byCode;

  // 3. Fetch outcomes for all sibling codes on this canonical plan + year.
  const allSiblingKeys = new Set<string>();
  for (const v of siblingCandidates.values()) v.forEach((k) => allSiblingKeys.add(k));
  const siblingCodes = Array.from(allSiblingKeys).map((k) => {
    const [type, code] = k.split(":");
    return { type, code };
  });

  const query = supabase
    .from("billing_code_plan_outcomes")
    .select("billing_code, billing_code_type, total_claims, paid_count, avg_paid_amount")
    .eq("canonical_plan_id", params.canonicalPlanId)
    .in("billing_code", siblingCodes.map((c) => c.code));
  const { data: outcomes } = params.planYear != null
    ? await query.eq("plan_year", params.planYear)
    : await query.is("plan_year", null);

  const outcomeByKey = new Map<string, { total: number; paid: number; avgPaid: number | null }>();
  for (const r of outcomes ?? []) {
    const total = Number(r.total_claims ?? 0);
    const paid = Number(r.paid_count ?? 0);
    if (total < K_ANON_PRICING) continue;
    outcomeByKey.set(`${r.billing_code_type}:${r.billing_code}`, {
      total,
      paid,
      avgPaid: r.avg_paid_amount != null ? Number(r.avg_paid_amount) : null,
    });
  }

  // 4. Attach sibling codes that HAVE pay data to each origin code.
  for (const [originKey, siblings] of siblingCandidates) {
    const rows: NonNullable<LineItemEvidence["siblingCodes"]> = [];
    for (const sibKey of siblings) {
      const outcome = outcomeByKey.get(sibKey);
      if (!outcome || outcome.paid <= 0) continue;
      const [type, code] = sibKey.split(":");
      rows.push({
        code,
        type,
        label: `${type} ${code}`,
        paidCount: outcome.paid,
        totalClaims: outcome.total,
        avgPaidAmount: outcome.avgPaid,
      });
    }
    if (rows.length > 0) byCode.set(originKey, rows);
  }

  return byCode;
}

async function loadPricingBenchmarks(
  supabase: SupabaseClient,
  params: {
    userId: string;
    codes: Array<{ code: string; type: string }>;
  },
): Promise<Map<string, NonNullable<LineItemEvidence["pricingBenchmark"]>>> {
  const byCode = new Map<string, NonNullable<LineItemEvidence["pricingBenchmark"]>>();
  if (params.codes.length === 0) return byCode;

  const region = await resolveUserRegion(supabase, params.userId);
  const codes = params.codes.map((c) => c.code);

  // pricing_aggregates is a materialized view; query by (procedure_code, region)
  // when region is known, otherwise fall back to national aggregate.
  const baseQuery = supabase
    .from("pricing_aggregates")
    .select("procedure_code, region, data_points, median_billed, avg_allowed, avg_patient_paid")
    .in("procedure_code", codes);

  const { data: rows } = region
    ? await baseQuery.eq("region", region)
    : await baseQuery;

  // Prefer region-specific rows (highest sample) per code; otherwise use any.
  const bestPerCode = new Map<string, { region: string | null; points: number; median: number | null; allowed: number | null; patientPaid: number | null }>();
  for (const r of rows ?? []) {
    const points = Number(r.data_points ?? 0);
    if (points < K_ANON_PRICING) continue;
    const existing = bestPerCode.get(r.procedure_code);
    if (!existing || points > existing.points) {
      bestPerCode.set(r.procedure_code, {
        region: r.region ?? null,
        points,
        median: r.median_billed != null ? Number(r.median_billed) : null,
        allowed: r.avg_allowed != null ? Number(r.avg_allowed) : null,
        patientPaid: r.avg_patient_paid != null ? Number(r.avg_patient_paid) : null,
      });
    }
  }

  for (const c of params.codes) {
    const best = bestPerCode.get(c.code);
    if (!best) continue;
    byCode.set(`${c.type}:${c.code}`, {
      region: best.region,
      medianBilled: best.median,
      medianAllowed: best.allowed,
      avgPatientPaid: best.patientPaid,
      sampleSize: best.points,
    });
  }

  return byCode;
}

async function resolveUserRegion(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("state")
    .eq("user_id", userId)
    .maybeSingle();
  return profile?.state ?? null;
}

async function loadCodeToSlugFallback(
  supabase: SupabaseClient,
  codes: Array<{ code: string; type: string }>,
): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  if (codes.length === 0) return byCode;
  const { data: rows } = await supabase
    .from("billing_code_mappings")
    .select("billing_code, billing_code_type, service_slug, confidence")
    .in("billing_code", codes.map((c) => c.code));
  for (const r of rows ?? []) {
    const key = `${r.billing_code_type}:${r.billing_code}`;
    if (!byCode.has(key) && Number(r.confidence ?? 0) >= 0.5) {
      byCode.set(key, r.service_slug);
    }
  }
  return byCode;
}

function buildLineItemEvidence(
  li: {
    id: string;
    line_number: number | null;
    billing_code: string | null;
    billing_code_type: string | null;
    service_slug: string | null;
    description: string | null;
    billed_amount: number | null;
    allowed_amount: number | null;
    insurance_paid: number | null;
    patient_owes: number | null;
    patient_paid_amount: number | null;
    network_status: string | null;
    metadata?: Record<string, unknown>;
  },
  coverageByServiceSlug: Map<string, PlanBenefitDetail>,
  communityByCode: Map<string, CommunityOutcomeRow>,
  siblingsByCode: Map<string, NonNullable<LineItemEvidence["siblingCodes"]>>,
  pricingByCode: Map<string, NonNullable<LineItemEvidence["pricingBenchmark"]>>,
  codeSlugFallback: Map<string, string>,
  planContext: PlanContext | null,
  peerCodesBySlug: Map<string, NonNullable<LineItemEvidence["peerCodes"]>>,
  /**
   * S99 B5 — pre-resolved canonical map for every line-item + code-fallback slug.
   * Keyed by raw slug → canonical sibling. Identity (no-op) for slugs without
   * aliases. resolveEvidence() builds this once before invoking
   * buildLineItemEvidence for each line item.
   */
  lineItemCanonicalMap: Map<string, string>,
  /**
   * Block C2 — true when the user attested this line's service was not rendered.
   * Overrides the signal-derived disputeType to `service_not_rendered` and forces
   * the spine grade to `statute` (the attestation IS the spine; no plan quote
   * backs it — §1f L2 truthfulness, never inflate to verbatim). The full billed
   * amount becomes the money weight (the whole charge is disputed).
   */
  attested: boolean,
  /**
   * S309 F12b — the claim's money context (header totals + the S140 effective
   * totals) so the derived actualPatientCost can fall through to the SHARED
   * per-line proration when every raw column is null (single-adjudication
   * bills). Optional: absent → the pre-F12b null behavior.
   */
  claimMoneyCtx?: { totalBilled: number; effectiveTotals: EffectiveClaimTotals },
  /**
   * S326 (member_composition_v1) — the member's composition scope. When set,
   * the line is built as the LETTER may argue it: findings whose ground the
   * member did not select are out of the line's evidence (one filter, and the
   * classifier, dollar weight, ground derivation, and detail blocks all
   * inherit); the attestation override applies only when service_not_rendered
   * is selected; peer codes enter only when coding_peer is selected. Null →
   * unscoped, byte-identical to today.
   */
  scope: CompositionScopeSet = null,
): LineItemEvidence {
  const billed = Number(li.billed_amount ?? 0);
  const insurancePaid = li.insurance_paid != null ? Number(li.insurance_paid) : null;
  const patientOwes = li.patient_owes != null ? Number(li.patient_owes) : null;
  const patientPaid = li.patient_paid_amount != null ? Number(li.patient_paid_amount) : null;
  // S309 F12b — the CLASSIFIER must see the same effective per-line money the
  // recovery prices with. On single-adjudication provider bills every raw
  // per-line column is null BY DESIGN (S304 — the header states adjudication
  // once), so actualPatientCost derived null → discrepancyAmount null → the
  // line never classified cost_share_misapplication → the letter rendered the
  // COVERAGE ask (no dollars) while the panel asserted the recovery — the
  // live half of the F12 gap (the fresh-bill letter Andrew drove). The raw
  // fields above stay raw (citations quote the document); only this DERIVED
  // analytic falls through to the shared proration, and only when the raw
  // chain is null → populated bills are byte-identical.
  const actualPatientCost = patientOwes != null
    ? patientOwes
    : insurancePaid != null
    ? Math.max(0, billed - insurancePaid)
    : claimMoneyCtx
    ? resolveStillOutstanding({
        lineBilled: billed,
        lineStillOutstanding: null,
        linePatientOwes: null,
        claimTotalBilled: claimMoneyCtx.totalBilled,
        claimStillOutstanding: claimMoneyCtx.effectiveTotals.patientResponsibility,
      })
    : null;

  // Resolve slug from the line item, or fall back to billing_code_mappings
  // when the original parse didn't tag the line with one. This is what lets
  // plan coverage lookup work for older claims.
  const codeKey = li.billing_code && li.billing_code_type
    ? `${li.billing_code_type}:${li.billing_code}`
    : null;
  const resolvedSlug = li.service_slug ?? (codeKey ? codeSlugFallback.get(codeKey) ?? null : null);
  // S99 B5 — normalize to canonical sibling before coverage lookup. loadCoverage
  // keys its byServiceSlug map by canonical, so we must match on canonical here.
  // Identity (no-op) when resolvedSlug has no alias relationship.
  const canonicalLookupSlug = resolvedSlug
    ? lineItemCanonicalMap.get(resolvedSlug) ?? resolvedSlug
    : null;
  const planBenefit = canonicalLookupSlug
    ? coverageByServiceSlug.get(canonicalLookupSlug) ?? null
    : null;

  const expectedPatientCost = planBenefit
    ? computeExpectedPatientCost(planBenefit, billed)
    : null;

  const discrepancyAmount = expectedPatientCost != null && actualPatientCost != null
    ? Math.max(0, actualPatientCost - expectedPatientCost)
    : null;

  const discrepancyReason = buildDiscrepancyReason({
    billed,
    expectedPatientCost,
    actualPatientCost,
    planBenefit,
    planContext,
  });

  const lookupKey = codeKey;
  const communityOutcome = lookupKey ? communityByCode.get(lookupKey) ?? null : null;
  const siblingCodes = lookupKey ? siblingsByCode.get(lookupKey) ?? null : null;
  const pricingBenchmark = lookupKey ? pricingByCode.get(lookupKey) ?? null : null;
  // S326 — under a member composition scope, a finding whose ground the member
  // did not select is OUT of this line's letter evidence: the classifier
  // signal, the dollar weight, groundsForLine's findingTypes, and the detail
  // blocks all read this one array, so one filter here scopes them all.
  // Findings mapped to no ground (upcoding / uncategorized) also drop under
  // scope — they cannot be selected, so a member-composed letter cannot argue
  // them. Unscoped (null) → unfiltered, byte-identical.
  const auditFindings = filterFindingsByScope(extractAuditFindings(li.metadata), scope);
  const auditRan = extractAuditRan(li.metadata);
  // S326 — the attestation override applies only when the member selected the
  // service_not_rendered ground (their attestation FACT persists in dispute
  // metadata either way; the letter argues it only when selected).
  const attestedInScope = attested && scopeAllows(scope, "service_not_rendered");
  // S74.6 D5 — peer codes for the slug (corroborated cross-user vote map).
  // Template renders the alternative-code section when this array has ≥ 2
  // entries (Q-S87-C7 letterEligible gate). Null when no slug OR no peers
  // cleared the corroboration gate. S326: masked under scope unless the
  // member selected coding_peer (the peer block is an argued ground).
  const peerCodes =
    resolvedSlug && scopeAllows(scope, "coding_peer")
      ? peerCodesBySlug.get(resolvedSlug) ?? null
      : null;

  // Block A — derive the EvidenceBundle normalization fields (§1e) from the
  // signals assembled above. Single producer; computeDisputeStrength consumes.
  // Block C2 — a user attestation that the service was not rendered OVERRIDES the
  // signal-derived classification: the dispute is now "service not rendered"
  // (documentary spine, §1d), graded `statute` because the spine is the user's
  // attestation — no plan quote backs it (§1f L2; never inflate to verbatim) — and
  // the whole billed amount is at stake (not just a cost-share delta).
  const signalDisputeType = classifyDisputeType(
    {
      planBenefit,
      peerCodes,
      communityOutcome,
      siblingCodes,
      pricingBenchmark,
      auditFindings,
      discrepancyAmount,
    },
    scope,
  );
  const baseDollarAtStake = deriveDollarAtStake({ discrepancyAmount, auditFindings }, scope);
  const disputeType: DisputeTypeClass = attestedInScope
    ? "service_not_rendered"
    : signalDisputeType;
  const citeGradeTier: CiteGradeTier = attestedInScope
    ? "statute"
    : deriveCiteGradeTier({ planBenefit });
  const dollarAtStake = attestedInScope
    ? Math.max(baseDollarAtStake, billed)
    : baseDollarAtStake;

  return {
    lineItemId: li.id,
    billingCode: li.billing_code && li.billing_code_type
      ? { value: li.billing_code, type: li.billing_code_type }
      : null,
    serviceSlug: resolvedSlug,
    serviceName: toServiceName(li.description, resolvedSlug),
    billedAmount: billed,
    insurancePaid,
    patientOwes,
    patientPaid,
    allowedAmount: li.allowed_amount != null ? Number(li.allowed_amount) : null,
    networkStatus: coerceNetworkTier(li.network_status),
    planBenefit,
    expectedPatientCost,
    actualPatientCost,
    discrepancyAmount,
    discrepancyReason,
    communityOutcome,
    siblingCodes,
    pricingBenchmark,
    auditFindings,
    auditRan,
    peerCodes,
    disputeType,
    citeGradeTier,
    dollarAtStake,
    // S326 — the SCOPED attestation: under member composition this line argues
    // not-rendered only when the member selected that ground (groundsForLine
    // reads this field, so the ground derivation self-scopes). The raw
    // attestation FACT persists in dispute.metadata.serviceAttestedLineIds
    // regardless — unselected ≠ un-attested.
    serviceNotRenderedAttested: attestedInScope,
  };
}

/**
 * S326 — the static finding→ground table (the catalog's own projection), built
 * once. The composition scope filters through THIS — the machine half of the
 * published mapping the member selects against (ground-mapping-sync fixture
 * holds table ⇔ published text together).
 */
const FINDING_TO_GROUND = deriveFindingToGround();

/** S326 — the valid ground-key set for metadata parsing (catalog keys, one SoT). */
const FINDING_TO_GROUND_VALID: Record<string, true> = Object.fromEntries(
  ALL_DISPUTE_GROUND_TYPES.map((g) => [g, true as const]),
);

/** S326 — drop findings whose ground the member did not select (and, under
 *  scope, findings mapped to no ground — unselectable ⇒ unarguable). Null
 *  scope → input unchanged. Null/empty input → unchanged. */
function filterFindingsByScope(
  findings: LineItemEvidence["auditFindings"],
  scope: CompositionScopeSet,
): LineItemEvidence["auditFindings"] {
  if (scope == null || findings == null) return findings;
  return findings.filter((f) => {
    const ground = FINDING_TO_GROUND[f.type as keyof typeof FINDING_TO_GROUND];
    return ground != null && scope.has(ground);
  });
}

function extractAuditFindings(metadata: Record<string, unknown> | undefined): LineItemEvidence["auditFindings"] {
  if (!metadata) return null;
  const raw = (metadata as { auditFindings?: unknown }).auditFindings;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const findings = raw
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      type: String(f.type ?? "finding"),
      severity: String(f.severity ?? "medium"),
      title: String(f.title ?? "Audit finding"),
      // §18 Stage 1 (Gap 1) — surface the persisted description so the grounds builder
      // reproduces the letter's finding-detail block on the rerender path. Additive.
      description: f.description != null ? String(f.description) : null,
      estimatedOvercharge: Number(f.estimatedOvercharge ?? 0),
      benchmarkAmount: f.benchmarkAmount != null ? Number(f.benchmarkAmount) : null,
      benchmarkSource: f.benchmarkSource != null ? String(f.benchmarkSource) : null,
      // R3 step 5.2 — surface the finding id + removal flag for the SET tier (dispute recovery).
      findingId: f.id != null ? String(f.id) : undefined,
      removed: f.removed === true,
      // R3 step 5.3 — surface the dismiss flag so the flag-gated recovery tiers + detail block skip
      // a user-dismissed finding (the CLAIM tier already filters it on claimFindings).
      dismissed: f.dismissed === true,
    }));
  return findings.length > 0 ? findings : null;
}

// Block C2.2 (S152) — has an audit actually RUN on this line? True when the
// engine wrote an `auditFindings` key (even an empty array = "checked, clean")
// OR stamped a rerun timestamp. Used to suppress the `audit_findings_missing`
// gap once a bill has been audited clean, and to clear it after a re-run.
function extractAuditRan(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return (
    Array.isArray((metadata as { auditFindings?: unknown }).auditFindings) ||
    (metadata as { auditRerunAt?: unknown }).auditRerunAt != null
  );
}

// Exported at S294 so the grounding gate below is fixture-covered rather than
// only reachable through a full resolveEvidence run.
export function computeExpectedPatientCost(
  benefit: PlanBenefitDetail,
  billed: number,
): number | null {
  if (benefit.covered === false) return null;
  // ── S294 — the letter-side grounding gate ────────────────────────────────
  // When the plan puts this service BEHIND the deductible, the stated
  // cost-share is what the patient owes AFTER the deductible is satisfied —
  // not what they owe today. This function had no deductible concept, so a
  // "No Charge after deductible" benefit (copay 0, deductibleApplies true)
  // returned an expected cost of $0, and every dollar of a legitimately
  // pre-deductible bill became an asserted discrepancy. On a $7,250-deductible
  // plan that is a letter claiming the full charge was an overcharge when the
  // patient genuinely owes it — a false assertion in an outbound legal
  // document, and exactly the credibility failure the honesty gate exists to
  // prevent.
  //
  // The claim engine already refuses to call an ungrounded shouldOwe "correct"
  // (recovery-math.ts §8, shouldOweGrounded). The letter never got that gate.
  // It does now: no deductible-met evidence reaches this resolver, so a
  // deductible-subject benefit yields NO expected cost and therefore no
  // discrepancy. Suppressing is the conservative direction — it can only
  // withdraw a claim we could not ground, never fabricate one.
  //
  // These claims are not lost, only deferred: once the user answers the
  // deductible question (S294 F3) that status can flow through here and the
  // grounded ones return. That wiring is the #6 unified-coverage-resolver
  // work, deliberately not smuggled in with this fix.
  if (benefit.deductibleApplies === true) return null;
  if (benefit.copay != null) return benefit.copay;
  if (benefit.coinsurance != null) return Math.round(billed * normalizeCoinsuranceDecimal(benefit.coinsurance) * 100) / 100;
  return null;
}

function buildDiscrepancyReason(params: {
  billed: number;
  expectedPatientCost: number | null;
  actualPatientCost: number | null;
  planBenefit: PlanBenefitDetail | null;
  planContext: PlanContext | null;
}): string | null {
  const { expectedPatientCost, actualPatientCost, planBenefit, planContext } = params;
  if (!planBenefit || expectedPatientCost == null || actualPatientCost == null) {
    return null;
  }
  if (actualPatientCost <= expectedPatientCost) return null;

  const planName = planContext?.plan?.planName ?? "Your plan";
  // S295 — the $0 / preventive case; see the twin in templates.ts
  // (renderLineItemEvidence). "a $0.00 copay" is a machine artifact in a
  // mailed letter. Non-zero values render byte-identically to before.
  const zeroCopay = planBenefit.copay === 0;
  const costDescriptor = planBenefit.copay != null
    ? `a ${formatUsd(planBenefit.copay)} copay`
    : planBenefit.coinsurance != null
    ? planBenefit.coinsurance === 0
      ? "no coinsurance"
      : `${normalizeCoinsurancePct(planBenefit.coinsurance)}% coinsurance`
    : "cost-sharing terms";
  return zeroCopay
    ? `${planName} covers this service with no copay. Billed patient responsibility is ${formatUsd(actualPatientCost)}.`
    : `${planName} specifies ${costDescriptor} for this service. Billed patient responsibility is ${formatUsd(actualPatientCost)}.`;
}

function resolveLegalBasis(letterType?: string): LegalBasisRef[] {
  switch (letterType) {
    case "insurance_appeal":
      return [
        {
          statute: "29 CFR §2560.503-1",
          summary: "Written explanation of denial must cite the specific plan provision on which it is based.",
          appliesTo: ["plan_benefit_citation"],
        },
        {
          statute: "PHSA §2719 (42 U.S.C. §300gg-19)",
          summary: "Requires full and fair review of internal and external appeals for group health plans.",
          appliesTo: ["appeal_process"],
        },
      ];
    case "balance_billing":
      return [
        {
          statute: "No Surprises Act (Public Law 116-260)",
          summary: "Protects patients from unexpected balance bills for emergency + certain in-network care.",
          appliesTo: ["balance_billing"],
        },
      ];
    case "overcharge":
    case "duplicate_charge":
      return [
        {
          statute: "State consumer protection laws",
          summary: "Require accurate billing and fair debt collection practices.",
          appliesTo: ["overcharge"],
        },
      ];
    case "negotiation":
      return [
        {
          statute: "State fair-pricing standards",
          summary: "Self-pay patients may negotiate based on published benchmarks.",
          appliesTo: ["self_pay"],
        },
      ];
    case "external_review":
      return [
        {
          statute: "PHSA §2719 (42 U.S.C. §300gg-19) / 45 CFR §147.136",
          summary: "Right to an independent external review after the internal appeal is exhausted.",
          appliesTo: ["appeal_process"],
        },
      ];
    case "debt_validation":
      return [
        {
          statute: "15 U.S.C. §1692g",
          summary: "Right to validation of a debt within 30 days of the collector's initial communication.",
          appliesTo: ["debt_validation"],
        },
        {
          statute: "15 U.S.C. §1692e(8)",
          summary: "A disputed debt must be reported as disputed to consumer reporting agencies.",
          appliesTo: ["debt_validation"],
        },
      ];
    case "final_notice":
      return [
        {
          statute: "State consumer protection laws",
          summary: "Require accurate billing; support escalation to state regulators.",
          appliesTo: ["overcharge"],
        },
      ];
    default:
      return [];
  }
}

function toServiceName(description: string | null, slug: string | null): string {
  if (description) return description;
  if (slug) return slug.replace(/_/g, " ");
  return "Service";
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
