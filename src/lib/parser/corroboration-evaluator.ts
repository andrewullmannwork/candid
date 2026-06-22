/**
 * Pattern 1 #3 corroboration evaluator (Phase 4.0.6 Task 4.0.6-D).
 *
 * Wraps mig 068 Postgres function `evaluate_pattern1_corroboration` which counts
 * distinct users with verified excerpts on the target user-side table
 * (insurance_plans for plan-identity fields when service_slug IS NULL;
 * plan_covered_services JOIN insurance_plans otherwise) and identifies the
 * max-value group.
 *
 * Per Q-P4.0.6-1 LOCK v4 = (B) app-level evaluator + shared Postgres function.
 * STABLE; pure read; no side effects.
 *
 * Callers should NOT invoke this directly from upload paths — use
 * commitUploadAndEvaluateCorroboration() from `commit-and-evaluate.ts` instead
 * (Q-1 v4 discipline mechanism; smoke test C13.5 enforces helper routing).
 */

import type { createServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface CorroboratorExcerpt {
  user_id_hash: string;
  excerpt: string | null;
  document_ref: string;
  recorded_at: string;
}

export interface CorroborationDecision {
  /** Distinct users with verified excerpts for this field on this canonical. */
  distinct_user_count: number;
  /** Users in the max-value group (the "consensus" value). */
  same_value_count: number;
  /** Configured corroboration threshold (Pattern 1 #3); default 3 until P.2 OTP. */
  threshold: number;
  /** True iff threshold met AND canonical not yet promoted (confidence < 0.9). */
  should_promote: boolean;
  /** True iff canonical already at 0.9 confidence AND we have new corroborator data. */
  should_append_source: boolean;
  /** True iff canonical_current_value === corroborated_value (deep JSONB equality). */
  value_matches_canonical: boolean;
  /** The max-value group's value (the "consensus" value). null if no users qualify. */
  corroborated_value: unknown | null;
  /** Top-K corroborator excerpts (default K=5) ordered by earliest recorded_at. */
  corroborator_excerpts: CorroboratorExcerpt[];
  /** Existing canonical confidence for this field (null if no canonical row yet). */
  current_canonical_confidence: number | null;
  /** Existing canonical value for this field (null if not promoted). */
  canonical_current_value: unknown | null;
  /** Which user-side table was queried (for telemetry / debugging). */
  target_table: "insurance_plans" | "plan_covered_services";
  /** Max-K config that bounded the corroborator_excerpts array. */
  max_k: number;
  /**
   * S99 B5 (mig 108) — resolved canonical slug for the input service_slug.
   * NULL for plan-identity-field evaluation (service_slug=null input). For
   * per-service evaluation: the canonical sibling sharing concept_id with
   * the input slug, OR the input slug itself if it's not in service_catalog
   * or has NULL concept_id. Callers should pass this (not the original
   * service_slug) to applyPromotionEvent so canonical_plan_services writes
   * land on the canonical row, not the alias.
   */
  canonical_service_slug: string | null;
  /**
   * S99 B5 (mig 108) — count of sibling slugs sharing the input slug's
   * concept_id (canonical + aliases). 0 when service_slug=null. 1 means
   * input slug has no aliases (the post-S95 state for all PROD data;
   * function behavior identical to mig 076). >1 means corroboration counted
   * across alias siblings.
   */
  sibling_slugs_count: number;
}

export interface EvaluateCorroborationResult {
  decision: CorroborationDecision | null;
  error: { message: string } | null;
}

/**
 * Calls evaluate_pattern1_corroboration Postgres function (mig 068).
 *
 * Caller decides what to do based on the returned decision:
 *   - decision.should_promote → applyPromotionEvent for first-time promotion
 *   - decision.should_append_source AND value_matches_canonical → applyPromotionEvent
 *     to append new corroborator excerpt to top-K
 *   - decision.should_append_source AND NOT value_matches_canonical → surface to
 *     active corroboration challenge state machine (Task 4.0.6-F)
 *
 * @param supabase Server-side Supabase client
 * @param canonicalPlanId UUID of the canonical_plans row
 * @param serviceSlug Service slug (null for plan-identity fields)
 * @param fieldName Field to evaluate (e.g. 'deductible_individual', 'copay')
 * @param placeOfService S205: per-service cost-share cell coord; null = aggregate (mig-108).
 *   Plan-identity callers pass null → the evaluator's NULL-conditional predicate is byte-identical.
 * @param component S205: per-service cell coord (facility/professional/global); null = aggregate.
 */
export async function evaluateCorroboration(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  serviceSlug: string | null,
  fieldName: string,
  placeOfService: string | null = null,
  component: string | null = null,
): Promise<EvaluateCorroborationResult> {
  const { data, error } = await supabase.rpc("evaluate_pattern1_corroboration", {
    p_canonical_plan_id: canonicalPlanId,
    p_service_slug: serviceSlug,
    p_field_name: fieldName,
    p_place_of_service: placeOfService,
    p_component: component,
  });

  if (error) {
    return { decision: null, error: { message: error.message } };
  }

  return { decision: data as CorroborationDecision, error: null };
}
