/**
 * CF-40 v4 (S73.5 D2b) — Layer 5 forced re-parse sampling.
 *
 * Per Subplan §2.8:
 *
 *   force_full_parse(U) = (
 *     user_id.is_admin == TRUE
 *     OR rand() < sample_rate(canonical_C.scale)
 *     OR now() - last_full_parse_at > staleness_threshold(scale)
 *     OR (canonical_C is admin-attested for doc_type=T AND zero organic full
 *         parses since attestation)
 *     OR canonical_C.divergence_pending_verification == TRUE
 *     OR (smart_skip_count_for_hash modulo N == 0)
 *   )
 *
 * Sample rates are statistically justified for 95% confidence of catching
 * drift within the scale-dependent detection horizon. See Subplan §2.8 table.
 *
 * Ship Gate G6: the sample rates, staleness thresholds, and the every-Nth gate are
 * flag-config-backed via `cfg` (defaults to the pre-G6 constants).
 */

import { DEFAULT_CF40V4_CONFIG, type CF40V4Config } from "./config";
import type {
  ForcedReparseDecision,
  ForcedReparseInput,
} from "./types";

export function decideForcedReparse(
  input: ForcedReparseInput,
  cfg: CF40V4Config = DEFAULT_CF40V4_CONFIG,
): ForcedReparseDecision {
  const rng = input.randomFn ?? Math.random;
  const now = input.now ?? new Date();

  // Trigger #1: all admin uploads always full-parse.
  if (input.isAdmin) {
    return { forceFullParse: true, reason: "admin_upload" };
  }

  // Trigger #4: verification mode (canonical-wide flag).
  if (input.divergencePendingVerification) {
    return { forceFullParse: true, reason: "verification_mode" };
  }

  // Trigger #5: admin-attestation validation.
  if (input.adminAttestedNeedsValidation) {
    return { forceFullParse: true, reason: "admin_attestation_validation" };
  }

  // Trigger #6: every-Nth-smart-skip on stable hash (reason enum kept as
  // "every_5th_smart_skip" for back-compat; N is config-tunable).
  const everyNth = cfg.forcedReparse.everyNthSmartSkip;
  if (input.smartSkipCount > 0 && everyNth > 0 && input.smartSkipCount % everyNth === 0) {
    return { forceFullParse: true, reason: "every_5th_smart_skip" };
  }

  // Trigger #3: temporal staleness.
  if (input.lastFullParseAt != null) {
    const last = input.lastFullParseAt instanceof Date
      ? input.lastFullParseAt
      : new Date(input.lastFullParseAt);
    if (!Number.isNaN(last.getTime())) {
      const staleDays = cfg.reparseSampling[input.scaleTier].temporalStalenessDays;
      const ageMs = now.getTime() - last.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > staleDays) {
        return { forceFullParse: true, reason: "temporal_staleness" };
      }
    }
  }

  // Trigger #2: statistical drift sample (last because cheapest signal).
  const sampleRate = cfg.reparseSampling[input.scaleTier].sampleRate;
  if (rng() < sampleRate) {
    return { forceFullParse: true, reason: "statistical_drift_sample" };
  }

  return { forceFullParse: false, reason: null };
}
