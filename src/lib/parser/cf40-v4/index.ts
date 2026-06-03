/**
 * CF-40 v4 (S73.5 D2b + D2c) — Smart-skip eligibility orchestrator.
 *
 * Per Subplan §2.9:
 *
 *   smart_skip_eligible(U) = (
 *     Layer 1 validity gates passed
 *     AND Layer 2: (canonical_C, H) stable
 *     AND Layer 3: (canonical_C, T) promoted
 *     AND Layer 4: re_baseline_required[T] != TRUE
 *     AND Layer 5: force_full_parse(U) == FALSE
 *   )
 *
 * Public re-exports surface the per-layer pure functions for testing + admin
 * UI consumption. The orchestrator below is the production seam — callers
 * (process-plan / process-eoc / process-plan_doc) invoke
 * `evaluateSmartSkipEligibility` to get a single eligibility decision.
 *
 * Feature-flag gate: when `cf40_v4_algorithm` is OFF (the default, the only
 * state in PROD until post-MVP empirical validation), v4 paths short-circuit
 * — caller MUST fall back to v3 mechanic (canonical_document_stability
 * per-(canonical, hash) stability with multi-slot candidates from mig 081+082).
 */

import { evaluateValidityGates } from "./validity-gates";
import { decideForcedReparse } from "./forced-reparse";
import {
  type SmartSkipEligibility,
  type ValidityGateInput,
  type ForcedReparseInput,
} from "./types";

export interface EligibilityInput {
  validityInput: ValidityGateInput;
  /** Layer 2 outcome: (canonical, hash) has Σ effective_weight ≥ 3.0. */
  layer2Stable: boolean;
  /** Layer 3 outcome: (canonical, doc_type) doctype_promoted=TRUE. */
  doctypePromoted: boolean;
  forcedReparseInput: ForcedReparseInput;
}

export function evaluateSmartSkipEligibility(
  input: EligibilityInput,
): SmartSkipEligibility {
  // Layer 1.
  const validity = evaluateValidityGates(input.validityInput);
  if (!validity.pass) {
    return {
      eligible: false,
      decisionLayer: "layer1",
      failureReason: validity.failureReasons[0] ?? "layer1_unknown",
    };
  }

  // Layer 2.
  if (!input.layer2Stable) {
    return {
      eligible: false,
      decisionLayer: "layer2",
      failureReason: "canonical_hash_not_stable",
    };
  }

  // Layer 3.
  if (!input.doctypePromoted) {
    return {
      eligible: false,
      decisionLayer: "layer3",
      failureReason: "doctype_not_promoted",
    };
  }

  // Layer 4 — re-baseline-required gate is part of Layer 1's
  // canonicalReBaselineRequired check, so already covered above. (Subplan §2.7
  // wires Layer 4 outputs INTO Layer 1's input via canonicalReBaselineRequired
  // + canonical-wide divergence_pending_verification.)

  // Layer 5 — final force-full-parse decision.
  const forced = decideForcedReparse(input.forcedReparseInput);
  if (forced.forceFullParse) {
    return {
      eligible: false,
      decisionLayer: "layer5",
      failureReason: `forced_reparse:${forced.reason}`,
    };
  }

  return { eligible: true, decisionLayer: "all_pass", failureReason: null };
}

// ── Public re-exports for callers + admin UI + tests ─────────────────────────

export * from "./types";
export * from "./scale-thresholds";
export * from "./trust-weight";
export * from "./validity-gates";
export * from "./forced-reparse";
export * from "./invalidation";
export * from "./promotion-evaluator";
export * from "./badge";
export * from "./dispute-treatment";

/**
 * Feature flag key for the v4 algorithm. Default OFF; flip post-MVP after
 * telemetry validates each layer in production.
 */
export const CF40_V4_FLAG_KEY = "cf40_v4_algorithm" as const;

/**
 * Feature flag key for admin attestation as MVP cold-start lever. Default ON
 * for MVP (Q-S73.5-16 LOCK); flip OFF post-MVP once organic Pattern 1 #3
 * fires reliably (~10K+ users on popular plans).
 */
export const ADMIN_ATTESTATION_FLAG_KEY = "admin_attestation_enabled" as const;
