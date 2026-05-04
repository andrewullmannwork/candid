/**
 * Canonical confidence promotion event mechanism (Phase 4.0.6 Task 4.0.6-E).
 *
 * Wraps mig 068 Postgres function `apply_promotion_event` which atomically writes
 * promoted value at 0.9 confidence to canonical field_provenance + appends top-K
 * sources (default K=5; tunable via canonical_promotion_event_v1.config.sources_array_max_k)
 * + increments corroborator_count integer (unbounded; Q-P4.0.6-3 LOCK v4 storage
 * bound) + inserts canonical_promotion_events log row.
 *
 * Holds pg_advisory_xact_lock keyed on (canonical_plan_id, service_slug, field_name)
 * per Q-P4.0.6-2 LOCK; auto-released on transaction commit. Race-aware: if a
 * concurrent writer beat us to first_promotion, the event_type becomes
 * 'corroboration_added' instead of 'first_promotion'.
 *
 * Pattern 1 #14 enforcement at function-grant layer: apply_promotion_event is
 * GRANTed only to service_role (NOT authenticated). Server-side TS code (this
 * module's caller) must use the supabase admin client.
 *
 * Callers should NOT invoke this directly from upload paths — use
 * commitUploadAndEvaluateCorroboration() from `commit-and-evaluate.ts` instead
 * (Q-1 v4 discipline mechanism; smoke test C13.5 enforces helper routing).
 */

import type { createServerClient } from "@/lib/supabase/server";
import type { CorroboratorExcerpt } from "./corroboration-evaluator";

type SupabaseClient = ReturnType<typeof createServerClient>;

export type FireSource =
  | "process-plan"
  | "process-eoc"
  | "reparse"
  | "correction-challenge-resolution"
  | "admin-ui"
  | "smoke-test";

export interface ApplyPromotionEventResult {
  eventId: string | null;
  error: { message: string } | null;
}

/**
 * Calls apply_promotion_event Postgres function (mig 068).
 *
 * @param supabase Server-side Supabase client (must be service_role)
 * @param canonicalPlanId UUID of the canonical_plans row
 * @param serviceSlug Service slug (null targets canonical_plans; non-null targets canonical_plan_services)
 * @param fieldName Field being promoted
 * @param corroboratedValue The value to write (already confirmed by ≥threshold distinct users via evaluator)
 * @param sources Array of corroborator excerpts; deduped + truncated to top-K server-side
 * @param fireSource Which code path triggered the firing (for telemetry)
 * @param actorUserId User whose event triggered the promotion (null for admin/system events)
 */
export async function applyPromotionEvent(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  serviceSlug: string | null,
  fieldName: string,
  corroboratedValue: unknown,
  sources: CorroboratorExcerpt[],
  fireSource: FireSource,
  actorUserId: string | null = null,
): Promise<ApplyPromotionEventResult> {
  const { data, error } = await supabase.rpc("apply_promotion_event", {
    p_canonical_plan_id: canonicalPlanId,
    p_service_slug: serviceSlug,
    p_field_name: fieldName,
    p_corroborated_value: corroboratedValue,
    p_sources: sources,
    p_fire_source: fireSource,
    p_actor_user_id: actorUserId,
  });

  if (error) {
    return { eventId: null, error: { message: error.message } };
  }

  return { eventId: data as string, error: null };
}
