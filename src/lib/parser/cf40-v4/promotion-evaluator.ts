/**
 * CF-40 v4 (S73.5 D2b) — Layer 3 per-(canonical, doc_type) promotion evaluator.
 *
 * Three independent criteria — all must pass for promotion (Subplan §2.4):
 *   (a) Three-dimensional corroboration: distinct users + total uploads +
 *       (distinct days OR time span) OR high-volume bypass + diversity at scale
 *   (b) Majority share over time-decayed weights ≥ supermajority threshold
 *   (c) Per-doc-type coverage completeness (computed in doctype-expected-counts.ts)
 *
 * Admin attestation path bypasses (a) + (b); (c) STILL required.
 */

import {
  computeCoverageScore,
  passesCoverageGate,
  type PlanDocType,
} from "@/lib/parser/doctype-expected-counts";
import {
  CORROBORATION_THRESHOLDS,
  supermajorityThreshold,
} from "./scale-thresholds";
import {
  type CorroborationCriterion,
  type CoverageCriterion,
  type PromotionEvalResult,
  type ScaleTier,
  type SupermajorityCriterion,
} from "./types";

function evaluateCorroboration(
  c: CorroborationCriterion,
  tier: ScaleTier,
): { pass: boolean; failureReasons: PromotionEvalResult["failureReasons"] } {
  const th = CORROBORATION_THRESHOLDS[tier];
  const failures: PromotionEvalResult["failureReasons"] = [];

  // Path 1: standard 3-D criterion.
  const distinctOk = c.distinctPhoneEmailUsers >= th.distinctUsers;
  const totalOk = c.totalQualifyingUploads >= th.totalUploads;
  const temporalOk =
    c.distinctCalendarDays >= th.distinctDays || c.timeSpanDays >= th.timeSpanDays;

  // Path 2: high-volume bypass for temporal req (large user count overrides
  // time distribution gate per Subplan §2.4(a) "OR distinct-user count ≥ S").
  const highVolumeBypass = c.highVolumeDistinctUsers >= th.highVolumeBypass;

  if (!distinctOk) failures.push("corroboration_distinct_users_below_threshold");
  if (!totalOk) failures.push("corroboration_total_uploads_below_threshold");
  if (!temporalOk && !highVolumeBypass) {
    failures.push("corroboration_temporal_distribution_below_threshold");
  }

  // Diversity requirements (medium + large only).
  if (th.ipBlocks != null && (c.ipBlockDiversity ?? 0) < th.ipBlocks) {
    failures.push("corroboration_diversity_below_threshold");
  }
  if (th.asns != null && (c.asnDiversity ?? 0) < th.asns) {
    failures.push("corroboration_diversity_below_threshold");
  }
  if (th.emailDomains != null && (c.emailDomainDiversity ?? 0) < th.emailDomains) {
    failures.push("corroboration_diversity_below_threshold");
  }

  return { pass: failures.length === 0, failureReasons: failures };
}

function evaluateSupermajority(
  s: SupermajorityCriterion,
  uploadCount: number,
  tier: ScaleTier,
): { pass: boolean; share: number; threshold: number } {
  if (s.totalWeight <= 0) return { pass: false, share: 0, threshold: 1 };
  const share = s.baselineWeight / s.totalWeight;
  const threshold = supermajorityThreshold(uploadCount, tier);
  return { pass: share >= threshold, share, threshold };
}

function evaluateCoverage(
  cov: CoverageCriterion,
  docType: PlanDocType,
): { pass: boolean; score: number } {
  const pass = passesCoverageGate(
    docType,
    cov.verifiedScalarCount,
    cov.verifiedServiceCount,
    cov.observedServiceCounts,
  );
  const score = computeCoverageScore(
    docType,
    cov.verifiedScalarCount,
    cov.verifiedServiceCount,
    cov.observedServiceCounts,
  );
  return { pass, score };
}

export function evaluateOrganicPromotion(input: {
  corroboration: CorroborationCriterion;
  supermajority: SupermajorityCriterion;
  coverage: CoverageCriterion;
  uploadCount: number;
  scaleTier: ScaleTier;
  docType: PlanDocType;
}): PromotionEvalResult {
  const corro = evaluateCorroboration(input.corroboration, input.scaleTier);
  const sup = evaluateSupermajority(input.supermajority, input.uploadCount, input.scaleTier);
  const cov = evaluateCoverage(input.coverage, input.docType);

  const failureReasons: PromotionEvalResult["failureReasons"] = [...corro.failureReasons];
  if (!sup.pass) failureReasons.push("supermajority_share_below_threshold");
  if (!cov.pass) failureReasons.push("coverage_score_below_threshold");

  return {
    promoted: failureReasons.length === 0,
    failureReasons,
    observed: {
      distinctUsers: input.corroboration.distinctPhoneEmailUsers,
      totalUploads: input.corroboration.totalQualifyingUploads,
      majorityShare: sup.share,
      coverageScore: cov.score,
    },
  };
}

/**
 * Admin-attested promotion path (Subplan §2.14).
 * Bypasses corroboration (a) + supermajority (b); coverage (c) STILL required.
 * `adminUploadCountPerDocType` must be ≥ 2 per Q-S73.5-21 LOCK.
 */
export function evaluateAdminAttestation(input: {
  coverage: CoverageCriterion;
  adminUploadCountPerDocType: number;
  docType: PlanDocType;
}): PromotionEvalResult {
  const failureReasons: PromotionEvalResult["failureReasons"] = [];

  if (input.adminUploadCountPerDocType < 2) {
    failureReasons.push("corroboration_total_uploads_below_threshold");
  }

  const cov = evaluateCoverage(input.coverage, input.docType);
  if (!cov.pass) failureReasons.push("coverage_score_below_threshold");

  return {
    promoted: failureReasons.length === 0,
    failureReasons,
    observed: {
      distinctUsers: 0, // n/a for admin path
      totalUploads: input.adminUploadCountPerDocType,
      majorityShare: 1.0, // admin baseline assumed authoritative
      coverageScore: cov.score,
    },
  };
}
