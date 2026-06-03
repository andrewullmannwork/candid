/**
 * S73.5 D5 — Per-document-type coverage configuration.
 *
 * Hardcoded baselines for plan-identity scalars + core service coverage per
 * doc type, plus median-adaptive growth helper. Drives Layer 3(c) coverage
 * completeness scoring in the CF-40 v4 algorithm. See [[plans/s73.5_cf40_refine]]
 * §2.4(c) and [[Candid_Data_Patterns]] Pattern 1 #16.
 *
 * Coverage score formula (Subplan §2.4(c)):
 *   coverage_score(canonical, doc_type) =
 *     0.5 * plan_identity_coverage + 0.5 * service_coverage
 *
 *   plan_identity_coverage =
 *     count(plan-identity scalars in canonical's field_provenance with verified
 *           provenance from this doc_type) /
 *     count(plan-identity scalars EXPECTED for this doc_type)
 *
 *   service_coverage =
 *     count(canonical_plan_services rows with verified provenance from this
 *           doc_type) /
 *     expected_service_count(canonical, doc_type)
 *
 * `expected_service_count` is median-adaptive but never below the hardcoded
 * baseline floor (Q-S73.5-20 LOCK):
 *
 *   expected_service_count(canonical, doc_type) =
 *     IF count(haiku_parses for canonical, doc_type) < 2:
 *       hardcoded_baseline_expected_service_count(doc_type)
 *     ELSE:
 *       max(
 *         hardcoded_baseline_expected_service_count(doc_type),  -- floor
 *         median(observed_service_count) * 0.85                 -- adapt up
 *       )
 *
 * Service slugs reference the existing STANDARD_SLUGS vocabulary in
 * `src/lib/sbc/haiku-prompts/common-medical-events.ts`. Plan-identity scalar
 * field names match the column names on `insurance_plans` (deductible/OOP) and
 * the cost-sharing fields on `plan_covered_services` for the named service
 * slugs (PCP/specialist copay).
 *
 * MVP scope: service slug lists are static for v4 launch. Plan-type-aware
 * applicability (ACA vs Medicare vs Employer) is a Phase 2 follow-up.
 */

import type { ClassifiedDocType } from "@/lib/classifier";

// ── Plan-document doc-type union (subset of ClassifiedDocType) ───────────────
//
// Mirrors `PLAN_DOCUMENT_TYPES` from `extraction-dedup.ts` but typed as a union
// so config lookups are exhaustive at compile time. `education_doc` is included
// here as a dormant stub per Subplan §6 ("Kept as dormant stubs in schema +
// config (easier enablement later)").
export type PlanDocType = "sbc" | "plan_document" | "eoc" | "education_doc";

// ── Plan-identity scalar field names (12 total for SBC/EOC/plan_doc) ─────────
//
// Subplan §2.4(c) — "in/out deductible individual+family + in/out OOP max
// individual+family + in/out PCP copay + in/out specialist copay" (12 fields).
// Names match `insurance_plans` columns for deductible/OOP and the per-service
// `plan_covered_services.in_copay`/`out_copay` for `pcp_visit`/`specialist_visit`
// rows. The integration in D2 maps these to actual storage locations.
export const PLAN_IDENTITY_SCALARS_FULL: readonly string[] = [
  "in_deductible_individual",
  "in_deductible_family",
  "out_deductible_individual",
  "out_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
  "out_oop_max_individual",
  "out_oop_max_family",
  "in_pcp_copay",
  "out_pcp_copay",
  "in_specialist_copay",
  "out_specialist_copay",
] as const;

// Education-doc subset (6 fields per Subplan §2.4(c) "12 (subset)" — wait, the
// Subplan table says education_doc has 6 plan-identity scalars). Pick the
// most-likely-present subset on employer benefits guides.
export const PLAN_IDENTITY_SCALARS_EDUCATION: readonly string[] = [
  "in_deductible_individual",
  "in_oop_max_individual",
  "out_deductible_individual",
  "out_oop_max_individual",
  "in_pcp_copay",
  "in_specialist_copay",
] as const;

// ── Core service slug sets (mapped to existing STANDARD_SLUGS vocabulary) ────

/** SBC-core 8 services per Subplan §2.4(c). */
export const SERVICES_SBC_CORE: readonly string[] = [
  "pcp_visit", // primary_care
  "specialist_visit", // specialist
  "urgent_care",
  "er_visit", // ER
  "generic_rx_tier1", // generic_rx
  "preventive_care", // preventive
  "diagnostic_test", // lab
  "advanced_imaging", // imaging
] as const;

/** EOC/plan_doc full-core 15 services = SBC-core 8 + 7 extra per Subplan §2.4(c). */
export const SERVICES_FULL_CORE: readonly string[] = [
  ...SERVICES_SBC_CORE,
  "inpatient_facility", // hospitalization
  "mental_health_outpatient", // mental_health
  "prenatal_visit", // maternity
  "childrens_dental", // pediatric (federally-mandated SBC element)
  "pt_rehab", // rehabilitation
  "mental_health_inpatient",
  "preferred_brand_rx_tier2", // brand_rx
] as const;

/** Education-doc representative subset (6 services per Subplan range 5-8). */
export const SERVICES_EDUCATION_CORE: readonly string[] = [
  "pcp_visit",
  "specialist_visit",
  "preventive_care",
  "generic_rx_tier1",
  "urgent_care",
  "er_visit",
] as const;

// ── Per-doc-type config record ───────────────────────────────────────────────

export interface DocTypeCoverageConfig {
  /** Field names of plan-identity scalars expected for this doc-type. */
  expectedPlanIdentityScalars: readonly string[];
  /** Service slugs expected as the baseline floor for this doc-type. */
  expectedCoreServices: readonly string[];
  /** Coverage score threshold for Layer 3(c) promotion gate. */
  coverageThreshold: number;
  /** Whether this doc-type contributes to canonical-level Verified gating. */
  participatesInCanonicalVerification: boolean;
}

/**
 * Per-doc-type coverage configuration. Source: Subplan §2.4(c) hardcoded
 * baselines + thresholds + median-adaptive growth helpers.
 *
 * `education_doc` is present but `participatesInCanonicalVerification=false`
 * — it's a Phase 2 stub that doesn't gate canonical-level Verified for MVP.
 */
export const DOC_TYPE_COVERAGE_CONFIG: Readonly<Record<PlanDocType, DocTypeCoverageConfig>> = {
  sbc: {
    expectedPlanIdentityScalars: PLAN_IDENTITY_SCALARS_FULL,
    expectedCoreServices: SERVICES_SBC_CORE,
    coverageThreshold: 0.80,
    participatesInCanonicalVerification: true,
  },
  eoc: {
    expectedPlanIdentityScalars: PLAN_IDENTITY_SCALARS_FULL,
    expectedCoreServices: SERVICES_FULL_CORE,
    coverageThreshold: 0.75,
    participatesInCanonicalVerification: true,
  },
  plan_document: {
    expectedPlanIdentityScalars: PLAN_IDENTITY_SCALARS_FULL,
    expectedCoreServices: SERVICES_FULL_CORE,
    coverageThreshold: 0.65,
    participatesInCanonicalVerification: true,
  },
  education_doc: {
    expectedPlanIdentityScalars: PLAN_IDENTITY_SCALARS_EDUCATION,
    expectedCoreServices: SERVICES_EDUCATION_CORE,
    coverageThreshold: 0.60,
    participatesInCanonicalVerification: false, // Phase 2 — bonus, not gating
  },
};

/**
 * Layer 3(c) coverage tunables not owned by the per-doc-type record above.
 * G6-tunable via `cf40_v4_config.coverage`; literal defaults are the pre-G6
 * 0.85 median factor + 0.5/0.5 identity/service split.
 */
export const COVERAGE_TUNABLES = {
  medianAdaptiveFactor: 0.85,
  planIdentityWeight: 0.5,
  serviceWeight: 0.5,
} as const;

/**
 * The Layer 3(c) coverage thresholds the evaluators read. Per-doc-type
 * `coverageThreshold` is lifted out of DOC_TYPE_COVERAGE_CONFIG so the whole
 * coverage gate is config-backed in one object (the expected-scalar / service
 * LISTS stay structural vocabulary, not threshold tuning).
 */
export interface CoverageConfig {
  /** coverage_score gate threshold per doc-type. */
  thresholds: Record<PlanDocType, number>;
  /** median(observed) × this is the adaptive expected-service floor. */
  medianAdaptiveFactor: number;
  /** coverage_score = planIdentityWeight·idCov + serviceWeight·svcCov. */
  planIdentityWeight: number;
  serviceWeight: number;
}

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  thresholds: {
    sbc: DOC_TYPE_COVERAGE_CONFIG.sbc.coverageThreshold,
    eoc: DOC_TYPE_COVERAGE_CONFIG.eoc.coverageThreshold,
    plan_document: DOC_TYPE_COVERAGE_CONFIG.plan_document.coverageThreshold,
    education_doc: DOC_TYPE_COVERAGE_CONFIG.education_doc.coverageThreshold,
  },
  medianAdaptiveFactor: COVERAGE_TUNABLES.medianAdaptiveFactor,
  planIdentityWeight: COVERAGE_TUNABLES.planIdentityWeight,
  serviceWeight: COVERAGE_TUNABLES.serviceWeight,
};

/**
 * Map ClassifiedDocType → PlanDocType when known; null otherwise. Used when
 * the algorithm needs to consult coverage config from a raw classification.
 */
export function toPlanDocType(t: ClassifiedDocType | string | null | undefined): PlanDocType | null {
  if (!t) return null;
  if (t === "sbc" || t === "eoc" || t === "plan_document") return t;
  if (t === "education_doc") return "education_doc";
  return null;
}

/**
 * Median-adaptive expected service count (Subplan §2.4(c) Q-S73.5-20 LOCK).
 *
 * - With < 2 prior parses: return hardcoded baseline (cold-start floor).
 * - With ≥ 2 prior parses: max(baseline, median(observed) * medianAdaptiveFactor).
 *   The factor allows variance below median without penalty; baseline floor
 *   prevents under-shooting on single-rich-parse outliers.
 */
export function expectedServiceCount(
  docType: PlanDocType,
  observedServiceCounts: readonly number[],
  cov: CoverageConfig = DEFAULT_COVERAGE_CONFIG,
): number {
  const baseline = DOC_TYPE_COVERAGE_CONFIG[docType].expectedCoreServices.length;
  if (observedServiceCounts.length < 2) return baseline;

  const sorted = [...observedServiceCounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const adaptive = Math.floor(median * cov.medianAdaptiveFactor);
  return Math.max(baseline, adaptive);
}

/**
 * Compute Layer 3(c) coverage_score per Subplan §2.4(c).
 *
 * @param docType — plan doc type
 * @param verifiedScalarCount — # plan-identity scalars with verified provenance
 *                              from this doc_type for this canonical
 * @param verifiedServiceCount — # canonical_plan_services rows with verified
 *                               provenance from this doc_type for this canonical
 * @param observedServiceCounts — per-parse observed service counts (drives
 *                                median-adaptive expected count)
 * @param cov — coverage tunables (defaults to the pre-G6 constants)
 */
export function computeCoverageScore(
  docType: PlanDocType,
  verifiedScalarCount: number,
  verifiedServiceCount: number,
  observedServiceCounts: readonly number[],
  cov: CoverageConfig = DEFAULT_COVERAGE_CONFIG,
): number {
  const cfg = DOC_TYPE_COVERAGE_CONFIG[docType];
  const expectedScalars = cfg.expectedPlanIdentityScalars.length;
  const expectedServices = expectedServiceCount(docType, observedServiceCounts, cov);

  const planIdentityCoverage =
    expectedScalars === 0 ? 0 : Math.min(1, verifiedScalarCount / expectedScalars);
  const serviceCoverage =
    expectedServices === 0 ? 0 : Math.min(1, verifiedServiceCount / expectedServices);

  return cov.planIdentityWeight * planIdentityCoverage + cov.serviceWeight * serviceCoverage;
}

/**
 * Layer 3(c) gate — does the (canonical, doc_type) pair satisfy coverage for
 * promotion? Compares computed coverage_score against doc-type-specific threshold.
 */
export function passesCoverageGate(
  docType: PlanDocType,
  verifiedScalarCount: number,
  verifiedServiceCount: number,
  observedServiceCounts: readonly number[],
  cov: CoverageConfig = DEFAULT_COVERAGE_CONFIG,
): boolean {
  const score = computeCoverageScore(
    docType,
    verifiedScalarCount,
    verifiedServiceCount,
    observedServiceCounts,
    cov,
  );
  return score >= cov.thresholds[docType];
}

/**
 * Canonical-level Verified rule (Subplan §2.5):
 *   canonical_verified = sbc_promoted AND (eoc_promoted OR plan_doc_promoted)
 *
 * education_doc is bonus only (does not gate).
 */
export function isCanonicalVerified(promotedDocTypes: ReadonlySet<PlanDocType>): boolean {
  if (!promotedDocTypes.has("sbc")) return false;
  return promotedDocTypes.has("eoc") || promotedDocTypes.has("plan_document");
}
