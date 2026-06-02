/**
 * CF-40 v4 (S73.5 D2b) — Layer 1 validity gates.
 *
 * Per Subplan §2.2: a parse contributes to stability counter AND coverage
 * scoring ONLY IF all gates pass. Failure → parse runs normally + data persists
 * to user-scoped row + NO contribution to stability/coverage. Logged for
 * telemetry.
 */

import {
  decideValidityRouting,
  isWithinAbsoluteAge,
} from "@/lib/plan/year-validity-window";
import type { ValidityGateFailure, ValidityGateInput, ValidityGateResult } from "./types";

// Thresholds (LOCKed Subplan §2.2 — do NOT re-tune during execution; if
// implementation reveals an issue, file as Phase 2 follow-up per Subplan §9).
export const VALIDITY_THRESHOLDS = {
  selfCheckPassRate: 0.95,
  ocrConfidence: 0.85,
  classificationConfidence: 0.90,
  fileSizeMinPlanDoc: 50_000, // 50 KB
  fileSizeMinSbc: 20_000, // 20 KB
  fileSizeMinEoc: 50_000,
  fileSizeMinEducation: 20_000,
} as const;

function fileSizeMinFor(docType: ValidityGateInput["docType"]): number {
  if (docType === "sbc") return VALIDITY_THRESHOLDS.fileSizeMinSbc;
  if (docType === "education_doc") return VALIDITY_THRESHOLDS.fileSizeMinEducation;
  if (docType === "eoc") return VALIDITY_THRESHOLDS.fileSizeMinEoc;
  return VALIDITY_THRESHOLDS.fileSizeMinPlanDoc; // plan_document
}

/**
 * Run all Layer 1 gates. Returns pass/fail + per-failure reason list.
 *
 * `fellBackToAbsoluteAge` is true when plan_year couldn't be extracted and the
 * caller used the absolute 12-month doc-age check instead of plan-year-aware
 * routing (Subplan §2.10).
 */
export function evaluateValidityGates(input: ValidityGateInput): ValidityGateResult {
  const failures: ValidityGateFailure[] = [];

  // Doc-quality gates are "enforce-when-present": a null signal means the parse
  // path did not produce that measurement (no P-8 verifier / no OCR step), so the
  // gate is inapplicable rather than failed. Reject only on a measured value that
  // is below threshold. See ValidityGateInput doc-comment.
  if (input.selfCheckPassRate !== null && input.selfCheckPassRate < VALIDITY_THRESHOLDS.selfCheckPassRate) {
    failures.push("self_check_pass_rate_below_threshold");
  }
  if (input.ocrConfidence !== null && input.ocrConfidence < VALIDITY_THRESHOLDS.ocrConfidence) {
    failures.push("ocr_confidence_below_threshold");
  }
  if (input.classificationConfidence !== null && input.classificationConfidence < VALIDITY_THRESHOLDS.classificationConfidence) {
    failures.push("classification_confidence_below_threshold");
  }

  // Plan-year-aware validity window (Subplan §2.10). Falls back to absolute
  // 12-month doc age if plan_year is unextractable.
  let fellBackToAbsoluteAge = false;
  const routing = decideValidityRouting(input.uploadedAt, input.documentPlanYear);
  if (routing.decision === "historical_only") {
    failures.push("outside_validity_window");
  } else if (routing.decision === "fallback_absolute_age") {
    fellBackToAbsoluteAge = true;
    if (!isWithinAbsoluteAge(input.uploadedAt)) {
      failures.push("outside_validity_window");
    }
  }

  if (input.fileSizeBytes < fileSizeMinFor(input.docType)) {
    failures.push("file_size_below_minimum");
  }

  // Layer 1 auth: email_verified OR phone_verified OR is_admin (Subplan §2.2
  // LOCK — relaxed from strict email+phone; Layer 2 weighting handles tier
  // nuance via TRUST_WEIGHT).
  if (
    input.uploaderTier === "unverified" &&
    !input.isAdmin
  ) {
    failures.push("uploader_unauthenticated");
  }

  if (input.isBanned) {
    failures.push("uploader_banned");
  }

  if (input.canonicalReBaselineRequired) {
    failures.push("canonical_re_baseline_required");
  }

  return {
    pass: failures.length === 0,
    failureReasons: failures,
    fellBackToAbsoluteAge,
  };
}
