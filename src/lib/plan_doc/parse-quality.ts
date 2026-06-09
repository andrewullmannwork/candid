/**
 * S92 (Session 92) — Pattern P-Q Parse Quality Flywheel scoring helper for
 * plan_doc parses. Derives the 4 columns persisted by mig 100 on `documents`:
 *
 *   - parse_quality_score        (0..1; composite of cite-grade + plan-identity)
 *   - parse_quality_layout       (Stage A label, e.g., "federal_sbc_8page")
 *   - parse_quality_failure_mode (dominant failure pattern, e.g., "truncation_retry")
 *   - parse_quality_signature    ("{layout}::{failure_mode}" — clustering key)
 *
 * Wired from process-plan.ts post-parse. The S93 admin tuning UI queries
 * `documents WHERE parse_quality_score < threshold` (relative bottom-decile per
 * doc-type — configurable via the `parse_quality_tuning_v1` feature flag's
 * `config` JSONB; default 0.10 = bottom 10%).
 *
 * Pattern P-Q "query-don't-store" architecture: no separate tuning corpus.
 * Admin pulls live samples at run-time.
 *
 * Bill parser flywheel mirror (same shape; separate failure-mode vocabulary)
 * lands in S93.
 */

import type { PlanDocHaikuParseResult } from "./types";
import type { PlanDocLayout } from "./layout-detector";

/** Plan-identity scalars that count toward the populated-rate denominator. */
const PLAN_IDENTITY_KEYS = [
  "planName",
  "insurerName",
  "planType",
  "metalTier",
  "planYear",
  "groupNumber",
  "networkType",
  "deductibleIndividual",
  "deductibleFamily",
  "oopMaxIndividual",
  "oopMaxFamily",
  "outDeductibleIndividual",
  "outDeductibleFamily",
  "outOopMaxIndividual",
  "outOopMaxFamily",
] as const;

export type ParseQualityFailureMode =
  | "services_zero" // no services extracted at all
  | "cost_sharing_gap" // S177 (RC-5 sentinel) — in-network individual deductible OR oop-max came back null; always-evaluated (fires even when score >= 0.80)
  | "truncation_retry" // haiku hit max_tokens; cite-grade dropped on retry
  | "plan_identity_low" // <8 of 15 plan-identity fields populated
  | "cite_grade_below_threshold" // services cite-grade < 80% but no specific signature
  | "peo_sponsor_confusion" // S91 sponsor-vs-carrier extraction error
  | "image_only_pdf" // OCR returned no extractable text
  | "extraction_failed"; // parser threw entirely

export interface ParseQualityScore {
  score: number; // 0..1
  layout: string; // PlanDocLayout label
  failureMode: ParseQualityFailureMode | null; // null when score >= 0.80 — EXCEPT cost_sharing_gap, which is always-evaluated (can be set at score >= 0.80)
  signature: string | null; // "{layout}::{failureMode}" — null when failureMode is null
}

/**
 * Composite quality score. Bias toward services-cite-grade since that's the
 * primary signal of parse fidelity — plan-identity scalars are easier to
 * recover via field-merge across chunks and tend to be high even when
 * services struggle. Weights tuned at S92 close after the Stage 0 head-to-head
 * showed services-cite-grade as the dominant differentiator.
 *
 * Weight breakdown:
 *   - 0.70 × services cite-grade rate
 *   - 0.30 × plan-identity populated rate (out of 15)
 */
export function computeParseQuality(
  result: PlanDocHaikuParseResult,
  layout: PlanDocLayout,
): ParseQualityScore {
  // Services cite-grade rate
  const servicesTotal = result.services.length;
  const servicesCiteGrade = result.services.filter(
    (s) =>
      s.patternP8?.source_excerpt_verified === "verified" &&
      s.patternP8?.source_section_verified === true,
  ).length;
  const servicesCiteRate = servicesTotal > 0 ? servicesCiteGrade / servicesTotal : 0;

  // Plan-identity populated rate
  let planIdentityPopulated = 0;
  for (const key of PLAN_IDENTITY_KEYS) {
    if (result.planIdentity[key]?.value !== null && result.planIdentity[key]?.value !== undefined) {
      planIdentityPopulated += 1;
    }
  }
  const planIdentityRate = planIdentityPopulated / PLAN_IDENTITY_KEYS.length;

  const score = servicesCiteRate * 0.7 + planIdentityRate * 0.3;

  // Cost-sharing recall tripwire (S177, RC-5 sentinel). The in-network individual
  // deductible + OOP max are the two highest-leverage plan-identity scalars and are
  // user-visible (no canonical inheritance: /plan reads the user plan, falling back
  // only to the user profile; /compare reads `?? null`). A null on either is a recall
  // loss worth surfacing REGARDLESS of the composite score — services-cite-grade is
  // 70% of `score`, so a great-services parse that drops the deductible would
  // otherwise score >= 0.80 and never flag. $0 cost-sharing is stored as 0 (not null),
  // so this fires only on genuine extraction gaps, never on real $0 plans. Insurer-
  // and doc-type-agnostic. Periodic check (G7): query documents WHERE
  // parse_quality_failure_mode='cost_sharing_gap' grouped by carrier/layout.
  const costSharingGap =
    result.planIdentity.deductibleIndividual?.value === null ||
    result.planIdentity.deductibleIndividual?.value === undefined ||
    result.planIdentity.oopMaxIndividual?.value === null ||
    result.planIdentity.oopMaxIndividual?.value === undefined;

  // Failure mode derivation. Order matters — first-match wins. Most specific
  // patterns come first so we don't bucket everything into the generic
  // "cite_grade_below_threshold". The S93 admin UI uses these as cluster
  // keys; specific labels surface targeted prompt-tweak work.
  let failureMode: ParseQualityFailureMode | null = null;
  if (score < 0.80) {
    const warnings = result.parseWarnings;
    const hasTruncationRetry = warnings.some((w) => w.includes("haiku_truncation_retry"));
    const insurerLooksLikePEO =
      result.planIdentity.insurerName?.value !== null &&
      /\b(PEO|TriNet|Insperity|Sequoia One|ADP TotalSource|Justworks)\b/i.test(
        result.planIdentity.insurerName?.value ?? "",
      );

    if (servicesTotal === 0 && planIdentityPopulated < 3) {
      // No useful extraction at all
      failureMode = "extraction_failed";
    } else if (servicesTotal === 0) {
      // Plan-identity recovered but 0 services — Stage 2 partial_success path
      failureMode = "services_zero";
    } else if (costSharingGap) {
      // S177 — services extracted but a critical cost-sharing scalar is missing.
      // Ranks above the softer/narrower modes below; total-extraction failures
      // (extraction_failed / services_zero) still win above.
      failureMode = "cost_sharing_gap";
    } else if (insurerLooksLikePEO) {
      // S91 sponsor-vs-carrier confusion
      failureMode = "peo_sponsor_confusion";
    } else if (planIdentityPopulated < 8) {
      failureMode = "plan_identity_low";
    } else if (hasTruncationRetry && servicesCiteRate < 0.8) {
      failureMode = "truncation_retry";
    } else {
      failureMode = "cite_grade_below_threshold";
    }
  } else if (costSharingGap) {
    // S177 — high-quality parse (score >= 0.80) that still dropped the deductible or
    // OOP max. Always flagged so a future per-carrier cost-sharing regression is
    // caught even when services parse cleanly (the blind spot a score-gated check has).
    failureMode = "cost_sharing_gap";
  }

  const signature = failureMode ? `${layout}::${failureMode}` : null;

  return {
    score: Math.round(score * 1000) / 1000, // 3-decimal precision
    layout,
    failureMode,
    signature,
  };
}
