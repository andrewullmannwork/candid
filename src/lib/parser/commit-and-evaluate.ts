/**
 * Shared helper wrapper for canonical promotion event evaluation post user-side
 * commit (Phase 4.0.6 Q-P4.0.6-1 LOCK v4 refinement — single discipline point).
 *
 * ALL upload + correction paths MUST route through this helper rather than
 * calling evaluateCorroboration / applyPromotionEvent directly. Smoke test C13.5
 * (Task 4.0.6-L) enforces this via grep-based assertion. Future write paths
 * added in Sessions 60+ MUST go through this helper — Engineering North Star #1
 * (Single code path).
 *
 * Pattern enforced (per Pattern 1 #14 + Principles §2 The Boundary):
 *   1. Caller commits user-side write first (insurance_plans / plan_covered_services
 *      / claim_line_items / etc.)
 *   2. Caller invokes this helper with field candidates to evaluate
 *   3. Helper iterates → evaluateCorroboration → decide → applyPromotionEvent (atomic)
 *   4. Idempotent: mig 068 dedupes sources by user_id_hash; same-user repeat-action
 *      doesn't inflate corroborator_count (mig 066 NOT EXISTS guard pattern at
 *      field level)
 *   5. No-op if canonical_promotion_event_v1 flag OFF (caller's responsibility
 *      to check; this helper assumes flag ON)
 *
 * What this helper does NOT do (yet):
 *   - Active corroboration challenge state machine handling (Task 4.0.6-F).
 *     When decision.should_append_source AND NOT value_matches_canonical, this
 *     helper logs a 'challenge_candidate' trace entry; Task 4.0.6-F adds the
 *     state machine that creates canonical_correction_challenges rows + sanity
 *     re-parse + admin notification.
 *   - Admin notification firing (Task 4.0.6-K).
 *   - Bulk-reparse / smart-skip path integration (future Sessions).
 */

import type { createServerClient } from "@/lib/supabase/server";
import { evaluateCorroboration, type CorroboratorExcerpt } from "./corroboration-evaluator";
import { applyPromotionEvent, type FireSource, type CitePolicy, type ProvenanceMeta } from "./promotion-event";
import {
  checkAndUpdatePendingChallenges,
  type PendingChallengeUpdate,
} from "./correction-challenge";
import { triageAutoReparse, type AutoReparseTraceEntry } from "./auto-reparse-triage";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface FieldEvaluationCandidate {
  /** Service slug (null for plan-identity fields like deductible_individual). */
  serviceSlug: string | null;
  /** Field name to evaluate (e.g. 'deductible_individual', 'copay', 'coinsurance'). */
  fieldName: string;
  /**
   * S205 (Corroboration-PS): the cost-share CELL coords for per-service candidates, so the
   * evaluator groups cross-user agreement per (service × place_of_service × component) cell
   * instead of aggregating across cells (which would mix e.g. facility vs office cost-sharing).
   * Undefined/null for plan-identity candidates → the evaluator's NULL-conditional predicates
   * collapse to TRUE = mig-108 aggregate (byte-identical to pre-S205 behavior).
   */
  placeOfService?: string | null;
  component?: string | null;
  /** mig 194/195 (S258): plan-local drug cost-share bucket — the 5th cell key. 'none'/undefined = not a
   *  bucketed drug line (byte-identical to pre-194 grouping). */
  planTierLabel?: string | null;
}

/**
 * Shared plan-identity candidates (Phase 4.0.6 v1 conservative list — high-leverage
 * cite-grade dispute fields). Both process-plan + process-eoc upload paths use
 * these as a base. Per-service candidates are derived per-parser separately.
 *
 * S102 (2026-05-19) — Aligned with plan_doc parser convention (`in_` prefix for
 * in-network fields). Pre-S102 the SBC items used unprefixed names which mismatched
 * the plan_doc parser's actual field_provenance writes (the only active parser
 * post `unified_plan_doc_parser_v1` flag flip), causing evaluator to return
 * corroborated_value=null and apply_promotion_event to reject. No downstream
 * consumer references the unprefixed names (greppable).
 */
export const PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC: readonly string[] = [
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
  // S256 (mig 192) — OON plan-identity. Promoted to canonical for live uploads AND the cold-start seed
  // regen (§16-D "live + seed"; columns + apply_promotion_event arms landed in mig 192). Additive — a
  // plan with no OON identity yields distinct_user_count=0 → no-op.
  "out_deductible_individual",
  "out_deductible_family",
  "out_oop_max_individual",
  "out_oop_max_family",
  "plan_name",
  "plan_year",
  "plan_type",
  "metal_level",
] as const;

export const PHASE_4_0_6_PLAN_IDENTITY_FIELDS_EOC: readonly string[] = [
  "plan_name",
  "insurer_name",
  "plan_year",
  "in_deductible_individual",
  "in_oop_max_individual",
  "out_deductible_individual",
  "out_oop_max_individual",
  "metal_level",
] as const;

export interface CommitAndEvaluateInput {
  /** UUID of the canonical_plans row that received user data. */
  canonicalPlanId: string;
  /** UUID of the user who just uploaded/corrected (for actor_user_id telemetry). */
  actorUserId: string;
  /** Which code path triggered this evaluation (for telemetry). */
  fireSource: FireSource;
  /** Field-level candidates to check for corroboration promotion. */
  candidates: FieldEvaluationCandidate[];
  /**
   * documents.id that triggered this commit cycle. Optional for backward
   * compatibility (correction paths, admin tools), but REQUIRED for the
   * Ing-A auto-reparse triage hook to fire — without it, telemetry can't
   * attribute fires to an upload and the D3 per-upload cap can't be enforced.
   * When omitted, the auto-reparse hook is a no-op for this call.
   */
  documentId?: string;
}

export type CommitAndEvaluateOutcome =
  /** Not enough corroboration; canonical not yet promoted. */
  | "no_change"
  /** Threshold met; canonical confidence 0.5/null → 0.9 (event_type='first_promotion'). */
  | "first_promotion"
  /** Already promoted; appended new corroborator to top-K (event_type='corroboration_added'). */
  | "corroboration_added"
  /** Canonical at 0.9 but new value mismatches; needs Task 4.0.6-F state machine. */
  | "challenge_candidate"
  /** Admin bypass (S102) — admin uploader fired apply_promotion_event with event_type='admin_override' regardless of corroboration count. */
  | "admin_override"
  /** Evaluator or apply call returned an error; trace contains errorMessage. */
  | "error";

export interface CommitAndEvaluateTraceEntry {
  serviceSlug: string | null;
  fieldName: string;
  outcome: CommitAndEvaluateOutcome;
  eventId?: string;
  errorMessage?: string;
  /** Set when outcome='challenge_candidate' AND pending challenges existed; details from Task 4.0.6-F integration. */
  challengeUpdates?: PendingChallengeUpdate[];
}

export interface CommitAndEvaluateResult {
  /** Number of fields that fired a promotion event (first_promotion + corroboration_added). */
  promotionsFired: number;
  /** Number of fields surfaced as challenge candidates (value mismatch with canonical). */
  challengeCandidates: number;
  /** Per-field outcome trace for debugging + telemetry. */
  trace: CommitAndEvaluateTraceEntry[];
  /** Aggregate error messages (one per failed candidate). */
  errors: string[];
  /**
   * Ing-A auto-reparse triage trace. Present when `input.documentId` is
   * provided AND `auto_reparse_enabled` flag is ON. Empty array when the
   * triage ran but no fields matched; undefined when the hook didn't run
   * (no documentId, flag off, cap exhausted, etc.).
   */
  autoReparseTrace?: AutoReparseTraceEntry[];
}

/**
 * Evaluates Pattern 1 #3 corroboration for each field candidate post user-side
 * commit; fires promotion events when threshold conditions are met.
 *
 * Idempotent: callers can re-invoke without risk of double-counting (mig 068
 * apply_promotion_event dedupes sources by user_id_hash).
 *
 * Errors per-candidate are collected in `errors` but don't halt iteration —
 * remaining candidates still evaluate. This matches Promise.allSettled-style
 * fault tolerance precedent from EOC parser dispatch (Phase 3.1A).
 */
/**
 * Admin-bypass helper — reads the actual extracted value for a plan-identity
 * field directly from the actor's most recent insurance_plans row linked to
 * the canonical. Used when the evaluator returns corroborated_value=null due
 * to field-name convention mismatch (plan_doc parser writes `in_` prefix;
 * SBC parser writes unprefixed). Tries both variants.
 *
 * Returns null if no value found under either name.
 */
/**
 * S102 — synthesize per-service candidates from plan_covered_services.
 * Used when input.candidates only contains plan-identity (e.g. plan_doc parser
 * path, which is the only active parser post unified_plan_doc_parser_v1 flag).
 * Returns the union of existing candidates + per-service candidates for every
 * (slug, field) pair where the actor's plan_covered_services has a value.
 * Runs for ALL callers — not admin-only — to fix the silently broken organic path.
 */
// Exported for the S205 candidate-cells fixture (gate d) — proves per-cell candidate emission.
export async function expandPerServiceCandidates(
  supabase: SupabaseClient,
  actorUserId: string,
  canonicalPlanId: string,
  existing: FieldEvaluationCandidate[],
): Promise<FieldEvaluationCandidate[]> {
  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("id")
    .eq("user_id", actorUserId)
    .eq("canonical_plan_id", canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan?.id) return existing;

  const { data: rows } = await supabase
    .from("plan_covered_services")
    .select("service_id, place_of_service, component, plan_tier_label, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit, annual_limit_value")
    .eq("insurance_plan_id", plan.id);
  if (!rows || rows.length === 0) return existing;

  const serviceIds = [...new Set(rows.map((r) => r.service_id as string))];
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug")
    .in("id", serviceIds);
  const idToSlug = new Map<string, string>();
  for (const s of services ?? []) idToSlug.set(s.id as string, s.slug as string);

  // S205 (Corroboration-PS): the candidate fieldName MUST be the plan_covered_services
  // COLUMN name. The mig-156 evaluator reads `plan_covered_services.field_provenance->
  // fieldName->'value'`, and that provenance is keyed by column name (see
  // buildPlanCoveredServiceProvenance). Pre-S205 this emitted canonical-style aliases
  // (copay/requires_prior_auth) that never matched the stored keys (in_copay/
  // prior_auth_required) → per-service corroboration counted 0 on every row. The
  // canonical-name mapping that mig-148 promotion needs is a canonical-WRITE concern,
  // handled in Part 2 (not here — Part 1 is user-scoped counting only).
  const perServiceColumns: (keyof typeof rows[0])[] = [
    "in_copay",
    "in_coinsurance",
    "in_deductible_applies",
    "covered",
    "prior_auth_required",
    "out_copay",
    "out_coinsurance",
    "out_deductible_applies",
    "requires_referral",
    "visit_limit",
  ];

  // S205: dedup + emit per CELL (a plan_covered_services row IS one (place_of_service,
  // component) cell). Pre-S205 the key omitted the cell, so a multi-cell service (e.g.
  // surgery facility + office) collapsed to one candidate, losing the other cell.
  const seen = new Set<string>();
  for (const c of existing) {
    seen.add(`${c.serviceSlug ?? ""}::${c.fieldName}::${c.placeOfService ?? ""}::${c.component ?? ""}::${c.planTierLabel ?? ""}`);
  }

  const added: FieldEvaluationCandidate[] = [];
  for (const row of rows) {
    const slug = idToSlug.get(row.service_id as string);
    if (!slug) continue;
    const placeOfService = (row.place_of_service as string | null) ?? null;
    const component = (row.component as string | null) ?? null;
    const planTierLabel = (row.plan_tier_label as string | null) ?? null;
    for (const column of perServiceColumns) {
      const v = (row as Record<string, unknown>)[column as string];
      if (v === undefined || v === null) continue;
      const key = `${slug}::${column as string}::${placeOfService ?? ""}::${component ?? ""}::${planTierLabel ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({ serviceSlug: slug, fieldName: column as string, placeOfService, component, planTierLabel });
    }
    // annual_limit: the candidate fieldName is 'annual_limit' but the source column is annual_limit_value
    // (a NUMBER; mig 187 / S241). Emit it mapped so readAdminPerServiceValue + the RPC arm see 'annual_limit'.
    const annual = (row as Record<string, unknown>).annual_limit_value;
    if (annual !== undefined && annual !== null) {
      const key = `${slug}::annual_limit::${placeOfService ?? ""}::${component ?? ""}::${planTierLabel ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        added.push({ serviceSlug: slug, fieldName: "annual_limit", placeOfService, component, planTierLabel });
      }
    }
  }
  return added.length > 0 ? [...existing, ...added] : existing;
}

/**
 * G2 — lift the FULL Pattern-P8 cite-grade block out of a field_provenance entry (not just source_excerpt),
 * so cold-start admin-attested promotions carry every key the A3 gate reads. Returns undefined when there
 * is no usable excerpt (a value with no excerpt is not cite-grade).
 */
function metaFromProvenanceEntry(entry: Record<string, unknown>): ProvenanceMeta | undefined {
  const excerpt = typeof entry.source_excerpt === "string" ? entry.source_excerpt : undefined;
  if (!excerpt?.trim()) return undefined;
  return {
    sourceExcerpt: excerpt,
    sourceExcerptVerified:
      typeof entry.source_excerpt_verified === "boolean" ? entry.source_excerpt_verified : undefined,
    sourceExcerptExtractionMethod:
      typeof entry.source_excerpt_extraction_method === "string" ? entry.source_excerpt_extraction_method : undefined,
    sourceSectionHint:
      typeof entry.source_section_hint === "string" ? entry.source_section_hint : undefined,
    sourceSectionVerified:
      typeof entry.source_section_verified === "boolean" ? entry.source_section_verified : undefined,
    resolutionSource:
      typeof entry.resolution_source === "string" ? entry.resolution_source : undefined,
  };
}

async function readAdminPerServiceValue(
  supabase: SupabaseClient,
  actorUserId: string,
  canonicalPlanId: string,
  serviceSlug: string,
  fieldName: string,
  placeOfService: string | null,
  component: string | null,
  planTierLabel: string | null,
): Promise<{ value: unknown; excerpts: CorroboratorExcerpt[]; meta?: ProvenanceMeta } | null> {
  // Find actor's most recent insurance_plans row linked to this canonical
  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("id")
    .eq("user_id", actorUserId)
    .eq("canonical_plan_id", canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan?.id) return null;

  // Look up service_catalog id for the slug
  const { data: svc } = await supabase
    .from("service_catalog")
    .select("id")
    .eq("slug", serviceSlug)
    .maybeSingle();
  if (!svc?.id) return null;

  // Find the plan_covered_services row for this (plan, service). Reads the full coverage column set +
  // annual_limit_value (source for the 'annual_limit' candidate) + field_provenance (the P-8 block).
  // mig 194/195 (S258): filter to the EXACT (pos, component, plan_tier_label) cell so a bucketed drug
  // service (generic condition_care vs all_other) returns THAT bucket's value, not an arbitrary sibling.
  const { data: rows } = await supabase
    .from("plan_covered_services")
    .select("id, field_provenance, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, out_copay, out_coinsurance, out_deductible_applies, requires_referral, visit_limit, annual_limit_value")
    .eq("insurance_plan_id", plan.id)
    .eq("service_id", svc.id)
    .eq("place_of_service", placeOfService ?? "any")
    .eq("component", component ?? "global")
    .eq("plan_tier_label", planTierLabel ?? "none")
    .limit(1);
  const row = rows?.[0];
  if (!row) return null;

  // annual_limit: candidate fieldName is 'annual_limit'; its source column + provenance key are
  // annual_limit_value (a NUMBER; mig 187 / S241). Other fields use the in_/unprefixed alias variants.
  const provenanceKeys =
    fieldName === "annual_limit"
      ? ["annual_limit_value", "annual_limit"]
      : fieldName.startsWith("in_")
        ? [fieldName, fieldName.slice(3)]
        : [fieldName, `in_${fieldName}`];

  // Try field_provenance first (carries the value AND the full Pattern-P8 block); fall back to the typed
  // column. G2: read the FULL block (metaFromProvenanceEntry), not just source_excerpt.
  const fp = (row.field_provenance ?? null) as Record<string, Record<string, unknown> | undefined> | null;
  if (fp) {
    for (const key of provenanceKeys) {
      const entry = fp[key];
      if (entry && entry.value !== undefined && entry.value !== null) {
        return {
          value: entry.value,
          excerpts: [{
            user_id_hash: actorUserId,
            excerpt: typeof entry.source_excerpt === "string" ? entry.source_excerpt : null,
            document_ref: row.id as string,
            recorded_at: new Date().toISOString(),
          }],
          meta: metaFromProvenanceEntry(entry),
        };
      }
    }
  }

  // Direct column fallback — keyed by the ALIGNED fieldName (+ annual_limit's special source column).
  // A column-only value has no excerpt → no meta (not cite-grade).
  const colMap: Record<string, unknown> = {
    in_copay: row.in_copay,
    in_coinsurance: row.in_coinsurance,
    in_deductible_applies: row.in_deductible_applies,
    covered: row.covered,
    prior_auth_required: row.prior_auth_required,
    out_copay: row.out_copay,
    out_coinsurance: row.out_coinsurance,
    out_deductible_applies: row.out_deductible_applies,
    requires_referral: row.requires_referral,
    visit_limit: row.visit_limit,
    annual_limit: row.annual_limit_value,
  };
  const direct = colMap[fieldName];
  if (direct !== undefined && direct !== null) {
    return {
      value: direct,
      excerpts: [{
        user_id_hash: actorUserId,
        excerpt: null,
        document_ref: row.id as string,
        recorded_at: new Date().toISOString(),
      }],
    };
  }
  return null;
}

async function readAdminPlanIdentityValue(
  supabase: SupabaseClient,
  actorUserId: string,
  canonicalPlanId: string,
  fieldName: string,
): Promise<{ value: unknown; excerpts: CorroboratorExcerpt[] } | null> {
  const { data } = await supabase
    .from("insurance_plans")
    .select("id, field_provenance, created_at")
    .eq("user_id", actorUserId)
    .eq("canonical_plan_id", canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fp = (data?.field_provenance ?? null) as Record<
    string,
    { value?: unknown; source_excerpt?: string; source_section_hint?: string } | undefined
  > | null;
  if (!fp) return null;
  const variants = fieldName.startsWith("in_")
    ? [fieldName, fieldName.slice(3)]
    : [fieldName, `in_${fieldName}`];
  for (const key of variants) {
    const entry = fp[key];
    if (entry && entry.value !== undefined && entry.value !== null) {
      const excerpt = entry.source_excerpt ?? null;
      return {
        value: entry.value,
        excerpts: [{
          user_id_hash: actorUserId, // admin's user_id directly (mig 068 dedupes)
          excerpt,
          document_ref: data?.id ?? "",
          recorded_at: new Date().toISOString(),
        }],
      };
    }
  }
  return null;
}

/**
 * N1 — derive the citation policy for a service-cell promotion. Plan-identity (slug null) is never a
 * coverage citation; a service field cites its source excerpt when one exists, else records no_excerpt.
 * (The cold-start seed path enriches this to the full P-8 block once readAdminPerServiceValue reads it.)
 */
function citePolicyForServiceCell(
  serviceSlug: string | null,
  excerpts: CorroboratorExcerpt[],
  meta?: ProvenanceMeta,
): CitePolicy {
  if (serviceSlug === null) return { cite: false, reason: "plan_identity" };
  // Prefer the full P-8 block (readAdminPerServiceValue, cold-start seed) over the bare excerpt (organic).
  if (meta && meta.sourceExcerpt?.trim()) return { cite: true, meta };
  const excerpt = excerpts[0]?.excerpt?.trim();
  return excerpt
    ? { cite: true, meta: { sourceExcerpt: excerpt } }
    : { cite: false, reason: "no_excerpt" };
}

export async function commitUploadAndEvaluateCorroboration(
  supabase: SupabaseClient,
  input: CommitAndEvaluateInput,
): Promise<CommitAndEvaluateResult> {
  const result: CommitAndEvaluateResult = {
    promotionsFired: 0,
    challengeCandidates: 0,
    trace: [],
    errors: [],
  };

  // S102 admin bypass — one users.is_admin lookup per call. When admin, every
  // candidate fires apply_promotion_event with event_type='admin_override'
  // regardless of Pattern 1 #3 corroboration count. Cold-start lever for the
  // admin-attested seed session (Pattern 1 #16 v4 spec; backported to v3).
  let actorIsAdmin = false;
  if (input.actorUserId) {
    const { data: actor } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", input.actorUserId)
      .maybeSingle();
    actorIsAdmin = actor?.is_admin === true;
  }

  // S102 — auto-expand per-service candidates from plan_covered_services.
  // process-plan.ts's derivePromotionCandidatesFromHaikuResult only produces
  // per-service candidates from the SBC parser path (VotedParseSBCResult);
  // plan_doc parser path (the only active path post `unified_plan_doc_parser_v1`)
  // passes null → only the 7 plan-identity candidates make it through. This
  // expansion ensures both organic + admin paths have a complete per-service
  // candidate list derived from the actor's actually-stored plan_covered_services
  // rows. Runs for ALL callers (not admin-only) — pre-S102 organic path was
  // also silently broken for plan_doc parses.
  let effectiveCandidates = input.candidates;
  if (input.actorUserId) {
    const expanded = await expandPerServiceCandidates(
      supabase,
      input.actorUserId,
      input.canonicalPlanId,
      input.candidates,
    );
    if (expanded.length > input.candidates.length) {
      effectiveCandidates = expanded;
    }
  }

  for (const candidate of effectiveCandidates) {
    const { serviceSlug, fieldName, placeOfService, component, planTierLabel } = candidate;

    // Step 1: evaluate corroboration (read-only)
    // Still runs for admin path — evaluator builds corroborated_value +
    // corroborator_excerpts from the admin's user-scoped data. The admin
    // path ignores decision.should_promote / .should_append_source flags
    // and force-promotes; everything else flows through normally.
    const { decision, error: evalError } = await evaluateCorroboration(
      supabase,
      input.canonicalPlanId,
      serviceSlug,
      fieldName,
      placeOfService ?? null, // S205: per-cell grouping; null for plan-identity = mig-108 aggregate
      component ?? null,
    );

    if (evalError || !decision) {
      const message = evalError?.message ?? "evaluator returned no decision";
      result.trace.push({ serviceSlug, fieldName, outcome: "error", errorMessage: message });
      result.errors.push(`evaluate ${fieldName}: ${message}`);
      continue;
    }

    // Step 2: route based on decision flags
    // S99 B5: use decision.canonical_service_slug (resolved canonical sibling
    // per mig 108) so canonical_plan_services writes land on the canonical row.
    // Falls back to the input serviceSlug for plan-identity fields (null) or
    // when the slug isn't in service_catalog (legacy data).
    const writeSlug = decision.canonical_service_slug ?? serviceSlug;

    // S102 admin-attestation bypass — fires before normal decision routing.
    // Same canonical_plan_services write path; only event_type differs.
    //
    // The evaluator returns corroborated_value=null when it can't find verified
    // excerpts for the requested field name. Plan_doc parser writes field_provenance
    // with `in_` prefix (e.g. `in_deductible_individual`) while PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC
    // requests the unprefixed name. For admin path, fall back to reading the value
    // directly from insurance_plans.field_provenance with both prefix variants.
    if (actorIsAdmin) {
      let attestValue = decision.corroborated_value;
      let attestExcerpts = decision.corroborator_excerpts;
      let attestMeta: ProvenanceMeta | undefined;
      // mig 194 (S258): for a per-service field the evaluator groups (slug,pos,component) TIER-BLIND, so its
      // corroborated_value would MIX drug buckets (generic condition_care $4 vs all_other $15) onto every
      // bucket row. Read the exact per-bucket value DIRECTLY from the admin's pcs cell instead — correct per
      // (pos, component, plan_tier_label). A non-bucketed row ('none') reads the single cell = same value as
      // before. Plan-identity (slug null) has no bucket → keep the evaluator value + its null-fallback.
      if (serviceSlug !== null) {
        const direct = await readAdminPerServiceValue(supabase, input.actorUserId!, input.canonicalPlanId, serviceSlug, fieldName, placeOfService ?? null, component ?? null, planTierLabel ?? null);
        if (direct) {
          attestValue = direct.value;
          attestExcerpts = direct.excerpts;
          attestMeta = direct.meta; // G2: the full P-8 block → cite-grade admin promotion
        }
      } else if (attestValue === null || attestValue === undefined) {
        const direct = await readAdminPlanIdentityValue(supabase, input.actorUserId!, input.canonicalPlanId, fieldName);
        if (direct) {
          attestValue = direct.value;
          attestExcerpts = direct.excerpts;
        }
      }
      if (attestValue === null || attestValue === undefined) {
        // No verified data found anywhere — skip; admin can't attest a field with no value.
        result.trace.push({ serviceSlug, fieldName, outcome: "no_change" });
        continue;
      }
      const { eventId, error: applyError } = await applyPromotionEvent(
        supabase,
        input.canonicalPlanId,
        writeSlug,
        fieldName,
        attestValue,
        attestExcerpts,
        input.fireSource,
        citePolicyForServiceCell(writeSlug, attestExcerpts, attestMeta),
        {
          actorUserId: input.actorUserId,
          forceEventType: "admin_override",
          // S205: promote to the candidate's CELL so a multi-cell service doesn't collapse every
          // cell's value onto the default 'any'/'global' canonical row. No-op for single-cell
          // (candidate cell IS 'any'/'global'); ignored by mig-148 for plan-identity (slug null).
          // mig 194 (S258): + the plan-local drug bucket, so per-bucket rows don't collapse.
          placeOfService: placeOfService ?? "any",
          component: component ?? "global",
          planTierLabel: planTierLabel ?? "none",
        },
      );
      if (applyError || !eventId) {
        const message = applyError?.message ?? "apply returned no event_id";
        result.trace.push({ serviceSlug, fieldName, outcome: "error", errorMessage: message });
        result.errors.push(`apply ${fieldName} (admin_override): ${message}`);
        continue;
      }
      result.trace.push({ serviceSlug, fieldName, outcome: "admin_override", eventId });
      result.promotionsFired += 1;
      continue;
    }

    if (decision.should_promote) {
      // First-time promotion: threshold met + canonical not yet promoted
      const { eventId, error: applyError } = await applyPromotionEvent(
        supabase,
        input.canonicalPlanId,
        writeSlug,
        fieldName,
        decision.corroborated_value,
        decision.corroborator_excerpts,
        input.fireSource,
        citePolicyForServiceCell(writeSlug, decision.corroborator_excerpts),
        {
          actorUserId: input.actorUserId,
          // S205: promote to the candidate's CELL (no-op for single-cell 'any'/'global'; plan-identity
          // passes 'any' which mig-148 ignores for the canonical_plans branch). mig 194 (S258): + the
          // plan-local drug bucket, so per-bucket rows don't collapse.
          placeOfService: placeOfService ?? "any",
          component: component ?? "global",
          planTierLabel: planTierLabel ?? "none",
        },
      );
      if (applyError || !eventId) {
        const message = applyError?.message ?? "apply returned no event_id";
        result.trace.push({ serviceSlug, fieldName, outcome: "error", errorMessage: message });
        result.errors.push(`apply ${fieldName} (first_promotion): ${message}`);
        continue;
      }
      result.trace.push({ serviceSlug, fieldName, outcome: "first_promotion", eventId });
      result.promotionsFired += 1;
    } else if (decision.should_append_source && decision.value_matches_canonical) {
      // Already-promoted canonical; new corroborator with matching value
      const { eventId, error: applyError } = await applyPromotionEvent(
        supabase,
        input.canonicalPlanId,
        writeSlug,
        fieldName,
        decision.corroborated_value,
        decision.corroborator_excerpts,
        input.fireSource,
        citePolicyForServiceCell(writeSlug, decision.corroborator_excerpts),
        {
          actorUserId: input.actorUserId,
          // S205: promote to the candidate's CELL (no-op for single-cell 'any'/'global'; plan-identity
          // passes 'any' which mig-148 ignores for the canonical_plans branch). mig 194 (S258): + the
          // plan-local drug bucket, so per-bucket rows don't collapse.
          placeOfService: placeOfService ?? "any",
          component: component ?? "global",
          planTierLabel: planTierLabel ?? "none",
        },
      );
      if (applyError || !eventId) {
        const message = applyError?.message ?? "apply returned no event_id";
        result.trace.push({ serviceSlug, fieldName, outcome: "error", errorMessage: message });
        result.errors.push(`apply ${fieldName} (corroboration_added): ${message}`);
        continue;
      }
      result.trace.push({ serviceSlug, fieldName, outcome: "corroboration_added", eventId });
      result.promotionsFired += 1;
    } else if (decision.should_append_source && !decision.value_matches_canonical) {
      // Canonical at 0.9 but new value mismatches — Task 4.0.6-F integration:
      // if there are pending challenges on this (canonical, service, field), update
      // their corroboration vs contradiction counts based on the observed value.
      const { updates, errors: challengeErrors } = await checkAndUpdatePendingChallenges(
        supabase,
        {
          canonicalPlanId: input.canonicalPlanId,
          serviceSlug,
          fieldName,
          observedValue: decision.corroborated_value,
          canonicalCurrentValue: decision.canonical_current_value,
        },
      );
      if (challengeErrors.length > 0) {
        result.errors.push(...challengeErrors.map((e) => `challenge ${fieldName}: ${e}`));
      }
      result.trace.push({
        serviceSlug,
        fieldName,
        outcome: "challenge_candidate",
        challengeUpdates: updates,
      });
      result.challengeCandidates += 1;
    } else {
      // Not enough corroboration AND canonical not yet promoted — no canonical write
      result.trace.push({ serviceSlug, fieldName, outcome: "no_change" });
    }
  }

  // ── Ing-A (S127) — auto-reparse triage hook ─────────────────────────────
  // Runs as the final post-promotion step. Gates: documentId present + flag
  // ON + per-upload cap not exhausted. Each gate enforced inside the helper.
  // Non-fatal wrap — auto-reparse failure must not block the promotion path.
  if (input.documentId) {
    try {
      const triageResult = await triageAutoReparse(supabase, {
        canonicalPlanId: input.canonicalPlanId,
        actorUserId: input.actorUserId,
        documentId: input.documentId,
        candidates: effectiveCandidates,
        trace: result.trace,
      });
      if (triageResult.trace.length > 0) {
        result.autoReparseTrace = triageResult.trace;
        console.log(
          `[auto-reparse-triage] document=${input.documentId} canonical=${input.canonicalPlanId} fields_evaluated=${triageResult.trace.length} cost_usd=${triageResult.totalCostUsd.toFixed(5)}`,
        );
      } else if (triageResult.skippedReason) {
        console.log(
          `[auto-reparse-triage] document=${input.documentId} skipped: ${triageResult.skippedReason}`,
        );
      }
    } catch (err) {
      console.error("[auto-reparse-triage] non-fatal hook error:", err);
    }
  }

  return result;
}
