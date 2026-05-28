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
import { normalizeCoinsurancePct, normalizeCoinsuranceDecimal } from "@/lib/billing/coinsurance";
import {
  resolveEffectiveClaimTotals,
  type EffectiveClaimTotals,
} from "@/lib/claims/effective-totals";

const K_ANON_PRICING = 5;

const K_ANON_THRESHOLD = 5;
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
}

export interface LineItemEvidence {
  lineItemId: string;
  billingCode: { value: string; type: string } | null;
  serviceSlug: string | null;
  serviceName: string;
  billedAmount: number;
  insurancePaid: number | null;
  patientOwes: number | null;
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
    estimatedOvercharge: number;
    benchmarkAmount: number | null;
    benchmarkSource: string | null;
  }> | null;
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
    | "bound_canonical_coverage_thin";
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
  },
): Promise<DisputeEvidence> {
  const { userId, claimIds, lineItemIds, planContext, letterType, disputeId } = params;
  const userConfirmedSamePlan = params.userConfirmedSamePlan ?? null;
  const canonicalPlanIdForBillYear = params.canonicalPlanIdForBillYear ?? null;

  if (claimIds.length === 0) {
    return emptyEvidence(planContext, letterType);
  }

  // Fetch claims + line items in parallel. Pull metadata on line items so
  // audit findings captured at claim creation can flow into the letter as
  // Medicare-benchmark / overcharge evidence.
  const [{ data: claims }, { data: lineItems }] = await Promise.all([
    supabase
      .from("claims")
      // S140 fix-pass H4 — header total fields needed by resolveEffectiveClaimTotals
      // helper. Without them, helper sees null headers, defaults all provenance
      // to 'per_line_sum' (broken telemetry signal + wrong Case D citation
      // framing prefix).
      .select("id, date_of_service, total_billed, total_insurance_paid, total_insurance_adjusted, total_patient_paid, total_patient_responsibility, amount_still_outstanding, plan_year, metadata, insurance_plan_id")
      .in("id", claimIds)
      .eq("user_id", userId),
    supabase
      .from("claim_line_items")
      // S140 fix-pass H4 — per-line numeric fields needed by helper to compute
      // accurate per-line sums against claim header. patient_paid_amount +
      // insurance_adjusted_amount were missing, causing sums = 0 always.
      .select("id, claim_id, line_number, billing_code, billing_code_type, service_slug, description, billed_amount, insurance_paid, insurance_adjusted_amount, patient_owes, patient_paid_amount, plan_year, metadata")
      .in("claim_id", claimIds),
  ]);

  const claimRows = claims ?? [];
  const rawLineItems = lineItems ?? [];
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
      }),
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

  let totalDiscrepancy = 0;
  let totalBilled = 0;

  for (const li of filteredLineItems) {
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
    );
    totalBilled += evidence.billedAmount;
    totalDiscrepancy += evidence.discrepancyAmount ?? 0;
    const claimEvidence = byClaim.get(li.claim_id);
    if (claimEvidence) claimEvidence.lineItemEvidence.push(evidence);
  }

  const claimsArr = Array.from(byClaim.values());

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
  );

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
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  // Prefer the persisted dispute id for the returnTo URL so the user lands
  // back on the right /disputes?dispute=<id> view after uploading. Fall
  // back to the claim id only when no dispute is persisted yet (e.g.,
  // legacy ?letter= flow); the user can still navigate manually.
  const returnIdent = disputeId ?? claimIds[0] ?? null;
  const returnTo = returnIdent ? encodeURIComponent(`/disputes?dispute=${returnIdent}`) : "";

  const allLineItems = claims.flatMap((c) => c.lineItemEvidence);
  const anyPlanBenefit = allLineItems.some((li) => li.planBenefit);
  const anyAudit = allLineItems.some((li) => li.auditFindings && li.auditFindings.length > 0);
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

  // S74 Pillar 3 — insurer appeals address missing. Only meaningful when the
  // letter actually goes to the insurer (insurance_appeal). For other letter
  // types the provider gap below covers the recipient gap; the insurer name
  // still appears in the body but no address is required.
  const insurerAddressMissing =
    !!planContext?.plan &&
    (!planContext.insurer || !planContext.insurer.appealsAddress);
  if (insurerAddressMissing && letterType === "insurance_appeal") {
    gaps.push({
      kind: "insurer_address_missing",
      title: "We don't have your insurer's appeals address on file",
      description:
        "Your insurance appeal needs a mailing address. Upload a more complete plan document so the appeals address can be extracted, or contact your insurer directly to confirm where appeals go.",
      ctaLabel: "Upload plan document",
      ctaHref: uploadHref,
    });
  }

  // S74 Pillar 3 — provider mailing address missing on the linked claim.
  // Suppress when the letter goes to the insurer (insurance_appeal) — the
  // recipient there is the insurer, not the provider.
  const providerAddressMissing =
    !!planContext &&
    (!planContext.providerContact || !planContext.providerContact.address);
  const goesToProvider =
    letterType !== "insurance_appeal" && letterType !== null;
  if (providerAddressMissing && goesToProvider) {
    gaps.push({
      kind: "provider_address_missing",
      title: "Add the provider's billing address",
      description:
        "Without this, the printed letter has no mailing address. Find the billing department address on the bill or the provider's website, then enter it below — it'll save with this dispute and any future ones for the same claim.",
      // Intentionally no ctaHref — the UI renders an inline form that POSTs to
      // /api/disputes/[disputeId]/provider-contact.
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

  if (!anyAudit) {
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
  };
}

async function loadCoverage(
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

  const canonicalCiteGradeBySlug = new Map<string, { sourceExcerpt: string; sourceSectionHint: string }>();
  if (canonicalPlanId) {
    const { data: extractions } = await supabase
      .from("canonical_haiku_extractions")
      .select("service_slug, source_excerpt, source_section_hint, created_at")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("field_name", "services_cost_sharing_row")
      .eq("source_excerpt_verified", "verified")
      .eq("source_section_verified", true)
      .order("created_at", { ascending: false });

    if (extractions) {
      for (const ext of extractions as Array<{ service_slug: string | null; source_excerpt: string | null; source_section_hint: string | null }>) {
        if (!ext.service_slug || !ext.source_excerpt) continue;
        // Most-recent wins (DESC ordering above + first-set semantics).
        if (!canonicalCiteGradeBySlug.has(ext.service_slug)) {
          canonicalCiteGradeBySlug.set(ext.service_slug, {
            sourceExcerpt: ext.source_excerpt,
            sourceSectionHint: ext.source_section_hint ?? "",
          });
        }
      }
    }
  }

  // plan_covered_services rows; service_catalog.slug is the natural join key.
  // sbc_excerpt/sbc_page exist after migration 050 (Phase 4.5).
  // field_provenance JSONB exists after migration 056 (Phase 3 — per-field P-8 storage).
  // Use optional chaining / default-null to stay compatible with rows that predate
  // either migration.
  const { data: rows } = await supabase
    .from("plan_covered_services")
    .select(
      "covered, in_copay, in_coinsurance, source, confidence, sbc_excerpt, sbc_page, field_provenance, service_catalog!inner(slug, name)",
    )
    .eq("insurance_plan_id", insurancePlanId);

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

  for (const r of rows as unknown as Array<{
    covered: boolean | null;
    in_copay: number | null;
    in_coinsurance: number | null;
    source: string | null;
    confidence: number | null;
    sbc_excerpt: string | null;
    sbc_page: number | null;
    field_provenance: Record<string, FieldProvenanceEntry> | null;
    service_catalog: { slug: string; name: string } | Array<{ slug: string; name: string }>;
  }>) {
    const cat = Array.isArray(r.service_catalog) ? r.service_catalog[0] : r.service_catalog;
    if (!cat?.slug) continue;
    const confidence = r.confidence ?? 0.5;
    if (confidence < MIN_PLAN_BENEFIT_CONFIDENCE) continue;

    // Phase 4 Task 4-E: derive Pattern P-8 cite-grade verification for the row's
    // primary cost field. Per Q-DR-4E-1 LOCK = (B), the gating field is in_copay
    // when copay is non-null; in_coinsurance otherwise. When P-8 verbatim is
    // available, prefer it over the legacy sbc_excerpt column.
    const primaryField = r.in_copay !== null ? "in_copay" : "in_coinsurance";
    const p8Entry = r.field_provenance?.[primaryField];
    const p8 = extractPatternP8FromEntry(p8Entry);
    const userRowCiteGrade = isCitationGrade(p8);

    // S72 commit 4: when user's own row lacks cite-grade Pattern P-8 excerpt,
    // fall back to canonical_haiku_extractions (cite-grade citations from any prior
    // cite-grade Haiku run on the same canonical+service). Closes CF-20 cite-grade
    // gap for smart-skipped users (post-CF-40 v3 dependency). Canonical fallback
    // is cite-grade by query construction (only verified+section_verified rows).
    const canonicalFallback = !userRowCiteGrade
      ? canonicalCiteGradeBySlug.get(cat.slug) ?? null
      : null;

    const preferredExcerpt =
      p8?.source_excerpt ?? canonicalFallback?.sourceExcerpt ?? r.sbc_excerpt ?? null;
    const sbcExcerptVerified = userRowCiteGrade || canonicalFallback !== null;
    // S74 Pillar 2 — track the excerpt's provenance for the canonical-fallback
    // transparency disclosure in EvidenceBlock.
    const citationSource: PlanBenefitDetail["citationSource"] = userRowCiteGrade
      ? "user_doc"
      : canonicalFallback !== null
      ? "canonical_fallback"
      : r.sbc_excerpt
      ? "legacy_sbc_excerpt"
      : null;

    // S99 B5 — key by canonical sibling (identity when no aliases exist).
    const canonicalSlug = coverageCanonicalMap.get(cat.slug) ?? cat.slug;
    byServiceSlug.set(canonicalSlug, {
      covered: r.covered !== false,
      copay: r.in_copay,
      coinsurance: r.in_coinsurance,
      source: r.source ?? "unknown",
      confidence,
      citation: `Plan SBC${r.sbc_page ? `, page ${r.sbc_page}` : ""} — ${cat.name}`,
      sbcExcerpt: preferredExcerpt,
      sbcPage: r.sbc_page ?? null,
      sbcExcerptVerified,
      citationSource,
      sourcedFrom: sourceTag,
      sourcedFromYear: sourceYear,
    });
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
async function loadCoverageFromCanonical(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  sourceTag: PlanBenefitDetail["sourcedFrom"],
  sourceYear: number | null,
): Promise<Map<string, PlanBenefitDetail>> {
  const byServiceSlug = new Map<string, PlanBenefitDetail>();

  // Pre-load cite-grade excerpts from canonical_haiku_extractions for this
  // canonical. Same query as loadCoverage's fallback path — only verified +
  // section-verified rows are cite-grade per Pattern P-8.
  const canonicalCiteGradeBySlug = new Map<
    string,
    { sourceExcerpt: string; sourceSectionHint: string }
  >();
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
      if (!canonicalCiteGradeBySlug.has(ext.service_slug)) {
        canonicalCiteGradeBySlug.set(ext.service_slug, {
          sourceExcerpt: ext.source_excerpt,
          sourceSectionHint: ext.source_section_hint ?? "",
        });
      }
    }
  }

  // Fetch canonical_plan_services rows for this canonical with service_catalog
  // join for display name. Schema per src/lib/plan/compare.ts:209+ — copay /
  // coinsurance / deductible_applies + OON mirrors + is_covered + field_provenance.
  const { data: rows } = await supabase
    .from("canonical_plan_services")
    .select(
      "is_covered, copay, coinsurance, source, confidence, field_provenance, service_catalog!inner(slug, name)",
    )
    .eq("canonical_plan_id", canonicalPlanId);

  if (!rows) return byServiceSlug;

  // Pre-resolve canonical sibling for every raw slug emitted by this
  // canonical's coverage rows — preserves the S99 B5 alias normalization
  // even though post-S95 reset this is identity (no aliases).
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

  for (const r of rows as unknown as Array<{
    is_covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    source: string | null;
    confidence: number | null;
    field_provenance: Record<string, FieldProvenanceEntry> | null;
    service_catalog: { slug: string; name: string } | Array<{ slug: string; name: string }>;
  }>) {
    const cat = Array.isArray(r.service_catalog) ? r.service_catalog[0] : r.service_catalog;
    if (!cat?.slug) continue;
    const confidence = r.confidence ?? 0.5;
    if (confidence < MIN_PLAN_BENEFIT_CONFIDENCE) continue;

    // Pattern P-8 cite-grade for canonical path: rely on
    // canonical_haiku_extractions excerpt (admin-attested or community-
    // verified cite-grade). canonical_plan_services rows may have their own
    // field_provenance with admin_attested sources; treat those as verified
    // structurally (Pattern 1 #4) but excerpt comes from haiku-extractions.
    const primaryField = r.copay !== null ? "copay" : "coinsurance";
    const p8Entry = r.field_provenance?.[primaryField];
    const p8 = extractPatternP8FromEntry(p8Entry);
    const userRowCiteGrade = isCitationGrade(p8);

    const canonicalCiteGrade = canonicalCiteGradeBySlug.get(cat.slug) ?? null;

    const preferredExcerpt =
      p8?.source_excerpt ?? canonicalCiteGrade?.sourceExcerpt ?? null;
    const sbcExcerptVerified = userRowCiteGrade || canonicalCiteGrade !== null;
    const citationSource: PlanBenefitDetail["citationSource"] = userRowCiteGrade
      ? "user_doc"
      : canonicalCiteGrade !== null
      ? "canonical_fallback"
      : null;

    const canonicalSlug = coverageCanonicalMap.get(cat.slug) ?? cat.slug;
    byServiceSlug.set(canonicalSlug, {
      covered: r.is_covered !== false,
      copay: r.copay,
      coinsurance: r.coinsurance,
      source: r.source ?? "canonical",
      confidence,
      citation: `Summary of Benefits and Coverage — ${cat.name}`,
      sbcExcerpt: preferredExcerpt,
      sbcPage: null,
      sbcExcerptVerified,
      citationSource,
      sourcedFrom: sourceTag,
      sourcedFromYear: sourceYear,
    });
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
    insurance_paid: number | null;
    patient_owes: number | null;
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
): LineItemEvidence {
  const billed = Number(li.billed_amount ?? 0);
  const insurancePaid = li.insurance_paid != null ? Number(li.insurance_paid) : null;
  const patientOwes = li.patient_owes != null ? Number(li.patient_owes) : null;
  const actualPatientCost = patientOwes != null
    ? patientOwes
    : insurancePaid != null
    ? Math.max(0, billed - insurancePaid)
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
  const auditFindings = extractAuditFindings(li.metadata);
  // S74.6 D5 — peer codes for the slug (corroborated cross-user vote map).
  // Template renders the alternative-code section when this array has ≥ 2
  // entries (Q-S87-C7 letterEligible gate). Null when no slug OR no peers
  // cleared the corroboration gate.
  const peerCodes = resolvedSlug
    ? peerCodesBySlug.get(resolvedSlug) ?? null
    : null;

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
    planBenefit,
    expectedPatientCost,
    actualPatientCost,
    discrepancyAmount,
    discrepancyReason,
    communityOutcome,
    siblingCodes,
    pricingBenchmark,
    auditFindings,
    peerCodes,
  };
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
      estimatedOvercharge: Number(f.estimatedOvercharge ?? 0),
      benchmarkAmount: f.benchmarkAmount != null ? Number(f.benchmarkAmount) : null,
      benchmarkSource: f.benchmarkSource != null ? String(f.benchmarkSource) : null,
    }));
  return findings.length > 0 ? findings : null;
}

function computeExpectedPatientCost(
  benefit: PlanBenefitDetail,
  billed: number,
): number | null {
  if (benefit.covered === false) return null;
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
  const costDescriptor = planBenefit.copay != null
    ? `a ${formatUsd(planBenefit.copay)} copay`
    : planBenefit.coinsurance != null
    ? `${normalizeCoinsurancePct(planBenefit.coinsurance)}% coinsurance`
    : "cost-sharing terms";
  return `${planName} specifies ${costDescriptor} for this service. Billed patient responsibility is ${formatUsd(actualPatientCost)}.`;
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
          statute: "ACA §2719",
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
