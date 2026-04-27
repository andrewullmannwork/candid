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

const K_ANON_PRICING = 5;

const K_ANON_THRESHOLD = 5;
const MIN_PLAN_BENEFIT_CONFIDENCE = 0.5;

export interface PlanBenefitDetail {
  covered: boolean;
  copay: number | null;
  coinsurance: number | null;
  source: string;
  confidence: number;
  citation: string;
  sbcExcerpt: string | null;
  sbcPage: number | null;
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
}

export interface ClaimEvidence {
  claimId: string;
  dateOfService: string | null;
  providerName: string | null;
  totalBilled: number;
  planYear: number | null;
  lineItemEvidence: LineItemEvidence[];
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
    | "audit_findings_missing";
  /** Short human-readable headline for the UI card. */
  title: string;
  /** One-line explanation of what adding this evidence unlocks. */
  description: string;
  /** Optional CTA label + href (upload, rerun audit, etc.). */
  ctaLabel?: string;
  ctaHref?: string;
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
  },
): Promise<DisputeEvidence> {
  const { userId, claimIds, lineItemIds, planContext, letterType, disputeId } = params;

  if (claimIds.length === 0) {
    return emptyEvidence(planContext, letterType);
  }

  // Fetch claims + line items in parallel. Pull metadata on line items so
  // audit findings captured at claim creation can flow into the letter as
  // Medicare-benchmark / overcharge evidence.
  const [{ data: claims }, { data: lineItems }] = await Promise.all([
    supabase
      .from("claims")
      .select("id, date_of_service, total_billed, plan_year, metadata, insurance_plan_id")
      .in("id", claimIds)
      .eq("user_id", userId),
    supabase
      .from("claim_line_items")
      .select("id, claim_id, line_number, billing_code, billing_code_type, service_slug, description, billed_amount, insurance_paid, patient_owes, plan_year, metadata")
      .in("claim_id", claimIds),
  ]);

  const claimRows = claims ?? [];
  const rawLineItems = lineItems ?? [];
  const filteredLineItems = lineItemIds && lineItemIds.length > 0
    ? rawLineItems.filter((li) => lineItemIds.includes(li.id))
    : rawLineItems;

  // Load plan_covered_services for the resolved plan (Phase 4 evidence block).
  const planId = planContext?.plan?.id ?? null;
  const coverageByServiceSlug = await loadCoverage(supabase, planId);

  // Load community outcomes (per billing code) for the canonical plan + year.
  // This is the "other claims that have been paid" signal. Requires canonical
  // plan + year to scope correctly. k-anonymity is enforced at render time.
  const canonicalPlanId = planContext?.plan?.canonicalPlanId ?? null;
  const planYear = planContext?.plan?.planYear ?? null;
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
  const byClaim = new Map<string, ClaimEvidence>();
  for (const c of claimRows) {
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
    });
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
  const gaps = computeEvidenceGaps(claimsArr, planContext, params.claimIds, disputeId ?? null);

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

  if (!planContext?.plan) {
    gaps.push({
      kind: "plan_document_missing",
      title: "Upload your insurance plan",
      description:
        "The letter can cite your plan's specific copay / coinsurance terms and SBC page references once your plan document is on file.",
      ctaLabel: "Upload plan document",
      ctaHref: uploadHref,
    });
  } else if (!anyPlanBenefit) {
    gaps.push({
      kind: "plan_document_incomplete",
      title: "Add pages from your plan document",
      description:
        "We have your plan on file but couldn't match any of this bill's codes to a covered service. Upload additional pages (or a more complete SBC) to add copay citations per line item.",
      ctaLabel: "Upload more plan pages",
      ctaHref: uploadHref,
    });
  }

  if (!anyAudit) {
    gaps.push({
      kind: "audit_findings_missing",
      title: "No audit findings attached",
      description:
        "Re-run the audit against this bill to attach Medicare benchmark comparisons + overcharge flags directly to the letter.",
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
): Promise<Map<string, PlanBenefitDetail>> {
  const byServiceSlug = new Map<string, PlanBenefitDetail>();
  if (!insurancePlanId) return byServiceSlug;

  // plan_covered_services rows; service_catalog.slug is the natural join key.
  // sbc_excerpt/sbc_page exist after migration 050 (Phase 4.5). Use optional
  // chaining / default-null to stay compatible when the columns aren't populated yet.
  const { data: rows } = await supabase
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, source, confidence, sbc_excerpt, sbc_page, service_catalog!inner(slug, name)")
    .eq("insurance_plan_id", insurancePlanId);

  if (!rows) return byServiceSlug;

  for (const r of rows as unknown as Array<{
    covered: boolean | null;
    in_copay: number | null;
    in_coinsurance: number | null;
    source: string | null;
    confidence: number | null;
    sbc_excerpt: string | null;
    sbc_page: number | null;
    service_catalog: { slug: string; name: string } | Array<{ slug: string; name: string }>;
  }>) {
    const cat = Array.isArray(r.service_catalog) ? r.service_catalog[0] : r.service_catalog;
    if (!cat?.slug) continue;
    const confidence = r.confidence ?? 0.5;
    if (confidence < MIN_PLAN_BENEFIT_CONFIDENCE) continue;
    byServiceSlug.set(cat.slug, {
      covered: r.covered !== false,
      copay: r.in_copay,
      coinsurance: r.in_coinsurance,
      source: r.source ?? "unknown",
      confidence,
      citation: `Plan SBC${r.sbc_page ? `, page ${r.sbc_page}` : ""} — ${cat.name}`,
      sbcExcerpt: r.sbc_excerpt ?? null,
      sbcPage: r.sbc_page ?? null,
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
  const planBenefit = resolvedSlug
    ? coverageByServiceSlug.get(resolvedSlug) ?? null
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
  if (benefit.coinsurance != null) return Math.round(billed * benefit.coinsurance * 100) / 100;
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
    ? `${Math.round(planBenefit.coinsurance * 100)}% coinsurance`
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
