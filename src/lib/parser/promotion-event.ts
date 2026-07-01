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
import { isPiiRedactionEnabled, redactExcerpt } from "./pii-redaction-gate";

type SupabaseClient = ReturnType<typeof createServerClient>;

export type FireSource =
  | "process-plan"
  | "process-eoc"
  | "reparse"
  | "correction-challenge-resolution"
  | "admin-ui"
  | "smoke-test"
  | "activate-plan-mismatch";

/**
 * Force-override event_type emitted by apply_promotion_event. Normal callers
 * pass null (function computes 'first_promotion' / 'corroboration_added' from
 * current canonical confidence). Admin bypass path (S102) passes
 * 'admin_override' so the canonical_promotion_events audit row records the
 * event as admin-attested rather than organic Pattern 1 #3 corroboration.
 */
export type ForceEventType =
  | "first_promotion"
  | "corroboration_added"
  | "value_corrected_via_challenge"
  | "admin_override";

export interface ApplyPromotionEventResult {
  eventId: string | null;
  error: { message: string } | null;
}

/**
 * Coverage fields that carry cite-grade provenance (the A3 gate inputs; mirrors the canonical coverage
 * columns mig 187 writes). A promotion of one of these SHOULD attach a source excerpt — `citationGap`
 * surfaces when it doesn't. Single source of truth.
 */
export const CITE_GRADE_FIELDS: ReadonlySet<string> = new Set([
  "in_copay", "in_coinsurance", "in_deductible_applies", "covered", "prior_auth_required",
  "out_copay", "out_coinsurance", "out_deductible_applies", "requires_referral", "visit_limit", "annual_limit",
]);

/**
 * The Pattern-P8 provenance block carried into apply_promotion_event's p_provenance_meta (mig 187 §14).
 * `sourceExcerpt` is required when cite:true; the rest are the cite-grade gate keys + the A3 resolution
 * stamp, all optional (the RPC whitelists + null-skips them — a partial block is honest = not-yet-citable).
 */
export interface ProvenanceMeta {
  sourceExcerpt: string;
  sourceExcerptVerified?: boolean;
  sourceExcerptExtractionMethod?: string;
  sourceSectionHint?: string;
  sourceSectionVerified?: boolean;
  resolutionSource?: string;
}

/**
 * N1 — every promotion MUST declare whether it carries a source citation. A required, no-default
 * discriminated union: a new caller cannot silently omit provenance on a cite-grade field (compile error),
 * and a cite:false records WHY (visible in review). The scale-safe contract that replaces a doc note.
 */
export type CitePolicy =
  | { cite: true; meta: ProvenanceMeta }
  | { cite: false; reason: "plan_identity" | "admin_attested" | "no_excerpt" };

/**
 * N1 layer-3 observability (pure, testable). Returns a human reason a cite-grade promotion lacks a usable
 * citation, else null. Does NOT block — admin attestation + challenge resolution legitimately promote
 * coverage cells with cite:false; this is a monitoring signal (rate/reasons of un-cited coverage writes),
 * not a gate. The compile-time type (above) is the actual guarantee.
 */
export function citationGap(fieldName: string, citePolicy: CitePolicy): string | null {
  if (!CITE_GRADE_FIELDS.has(fieldName)) return null;
  if (!citePolicy.cite) return `no citation (reason=${citePolicy.reason})`;
  if (!citePolicy.meta.sourceExcerpt?.trim()) return "cite:true but empty sourceExcerpt";
  return null;
}

/**
 * Calls apply_promotion_event Postgres function (mig 068 + mig 111).
 *
 * @param supabase Server-side Supabase client (must be service_role)
 * @param canonicalPlanId UUID of the canonical_plans row
 * @param serviceSlug Service slug (null targets canonical_plans; non-null targets canonical_plan_services)
 * @param fieldName Field being promoted
 * @param corroboratedValue The value to write (already confirmed by ≥threshold distinct users via evaluator)
 * @param sources Array of corroborator excerpts; deduped + truncated to top-K server-side
 * @param fireSource Which code path triggered the firing (for telemetry)
 * @param actorUserId User whose event triggered the promotion (null for admin/system events)
 * @param forceEventType If non-null, overrides the computed event_type. Used by the admin bypass path (S102) to emit 'admin_override' regardless of canonical confidence.
 * @param placeOfService S167 Thesaurus modifier for the 4-col canonical_plan_services key (mig 148). Default 'any'; Phase 1 supplies real values once the parser produces pos/component. Ignored when serviceSlug is null (canonical_plans branch).
 * @param component S167 Thesaurus component modifier ('facility'|'professional'|'global'). Default 'global'. Ignored when serviceSlug is null.
 */
export async function applyPromotionEvent(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  serviceSlug: string | null,
  fieldName: string,
  corroboratedValue: unknown,
  sources: CorroboratorExcerpt[],
  fireSource: FireSource,
  // N1 (mig 187 §14): every promotion MUST declare its citation policy — REQUIRED, no default. cite:true
  // carries the Pattern-P8 provenance block into p_provenance_meta; cite:false records WHY it has none.
  // The compile-time guarantee that a cite-grade coverage field is never silently promoted without
  // provenance (the scale-safe replacement for "remember to pass the excerpt").
  citePolicy: CitePolicy,
  opts: {
    actorUserId?: string | null;
    forceEventType?: ForceEventType | null;
    // S167 Thesaurus (mig 148): pos/component target the canonical_plan_services key. Defaults
    // 'any'/'global'; real values flow once the parser produces pos/component.
    placeOfService?: string;
    component?: string;
    // mig 194 (S258): plan-local drug cost-share BUCKET — the 5th key column. Defaults 'none'; real values
    // flow once the resolver emits planTierLabel (cold-start dup-key fix). 'none' == byte-identical to pre-194.
    planTierLabel?: string;
  } = {},
): Promise<ApplyPromotionEventResult> {
  const { actorUserId = null, forceEventType = null, placeOfService = "any", component = "global", planTierLabel = "none" } = opts;
  // Ing-E: redact PII from cross-user excerpts before they land in canonical
  // field_provenance.sources[].excerpt. This is the single chokepoint for BOTH
  // canonical_plans (service_slug NULL) and canonical_plan_services + every caller
  // (admin_override / first_promotion / corroboration_added). Flag OFF (default) →
  // same `sources` reference → byte-identical.
  const piiOn = await isPiiRedactionEnabled(supabase);
  const redactedSources = piiOn
    ? sources.map((s) => ({
        ...s,
        excerpt: redactExcerpt(s.excerpt, true, "field_provenance.sources[].excerpt"),
      }))
    : sources;

  // N1 §14: build p_provenance_meta from the cite policy. cite:false → null (the RPC defaults it →
  // byte-identical to the pre-contract write). cite:true → the P-8 keys (the RPC whitelists + null-skips).
  const provenanceMeta = citePolicy.cite
    ? {
        source_excerpt: citePolicy.meta.sourceExcerpt,
        source_excerpt_verified: citePolicy.meta.sourceExcerptVerified ?? null,
        source_excerpt_extraction_method: citePolicy.meta.sourceExcerptExtractionMethod ?? null,
        source_section_hint: citePolicy.meta.sourceSectionHint ?? null,
        source_section_verified: citePolicy.meta.sourceSectionVerified ?? null,
        resolution_source: citePolicy.meta.resolutionSource ?? null,
      }
    : null;
  const gap = citationGap(fieldName, citePolicy);
  if (gap) console.warn(`[promotion-event] cite-grade field '${fieldName}': ${gap}`);

  const { data, error } = await supabase.rpc("apply_promotion_event", {
    p_canonical_plan_id: canonicalPlanId,
    p_service_slug: serviceSlug,
    p_field_name: fieldName,
    p_corroborated_value: corroboratedValue,
    p_sources: redactedSources,
    p_fire_source: fireSource,
    p_actor_user_id: actorUserId,
    p_force_event_type: forceEventType,
    p_place_of_service: placeOfService,
    p_component: component,
    p_provenance_meta: provenanceMeta,
    p_plan_tier_label: planTierLabel,
  });

  if (error) {
    return { eventId: null, error: { message: error.message } };
  }

  return { eventId: data as string, error: null };
}
