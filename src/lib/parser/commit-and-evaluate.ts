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
import { applyPromotionEvent, type FireSource } from "./promotion-event";
import {
  checkAndUpdatePendingChallenges,
  type PendingChallengeUpdate,
} from "./correction-challenge";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface FieldEvaluationCandidate {
  /** Service slug (null for plan-identity fields like deductible_individual). */
  serviceSlug: string | null;
  /** Field name to evaluate (e.g. 'deductible_individual', 'copay', 'coinsurance'). */
  fieldName: string;
}

/**
 * Shared plan-identity candidates (Phase 4.0.6 v1 conservative list — high-leverage
 * cite-grade dispute fields). Both process-plan + process-eoc upload paths use
 * these as a base. Per-service candidates are derived per-parser separately.
 *
 * Note on convention: SBC parser writes 'deductible_individual' (in-network);
 * EOC parser writes 'in_deductible_individual'. v1 corroboration evaluates these
 * field-keys independently. Cross-source key harmonization is Phase 5+ work.
 */
export const PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC: readonly string[] = [
  "deductible_individual",
  "deductible_family",
  "oop_max_individual",
  "oop_max_family",
  "plan_name",
  "plan_year",
  "plan_type",
] as const;

export const PHASE_4_0_6_PLAN_IDENTITY_FIELDS_EOC: readonly string[] = [
  "plan_name",
  "insurer_name",
  "plan_year",
  "in_deductible_individual",
  "in_oop_max_individual",
  "out_deductible_individual",
  "out_oop_max_individual",
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
 * S102 admin-bypass — synthesize per-service candidates from plan_covered_services.
 * Used when input.candidates only contains plan-identity (e.g. plan_doc parser
 * path). Returns the union of existing candidates + per-service candidates for
 * every (slug, field) pair where the actor's plan_covered_services has a value.
 */
async function expandAdminPerServiceCandidates(
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
    .select("service_id, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required")
    .eq("insurance_plan_id", plan.id);
  if (!rows || rows.length === 0) return existing;

  const serviceIds = [...new Set(rows.map((r) => r.service_id as string))];
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug")
    .in("id", serviceIds);
  const idToSlug = new Map<string, string>();
  for (const s of services ?? []) idToSlug.set(s.id as string, s.slug as string);

  const perServiceFields: { name: string; rowKey: keyof typeof rows[0] }[] = [
    { name: "copay", rowKey: "in_copay" },
    { name: "coinsurance", rowKey: "in_coinsurance" },
    { name: "deductible_applies", rowKey: "in_deductible_applies" },
    { name: "is_covered", rowKey: "covered" },
    { name: "requires_prior_auth", rowKey: "prior_auth_required" },
  ];

  const seen = new Set<string>();
  for (const c of existing) seen.add(`${c.serviceSlug ?? ""}::${c.fieldName}`);

  const added: FieldEvaluationCandidate[] = [];
  for (const row of rows) {
    const slug = idToSlug.get(row.service_id as string);
    if (!slug) continue;
    for (const { name, rowKey } of perServiceFields) {
      const v = (row as Record<string, unknown>)[rowKey as string];
      if (v === undefined || v === null) continue;
      const key = `${slug}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push({ serviceSlug: slug, fieldName: name });
    }
  }
  return added.length > 0 ? [...existing, ...added] : existing;
}

async function readAdminPerServiceValue(
  supabase: SupabaseClient,
  actorUserId: string,
  canonicalPlanId: string,
  serviceSlug: string,
  fieldName: string,
): Promise<{ value: unknown; excerpts: CorroboratorExcerpt[] } | null> {
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

  // Find the plan_covered_services row(s) for this (plan, service)
  const { data: rows } = await supabase
    .from("plan_covered_services")
    .select("id, field_provenance, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required")
    .eq("insurance_plan_id", plan.id)
    .eq("service_id", svc.id)
    .limit(1);
  const row = rows?.[0];
  if (!row) return null;

  // Try field_provenance first (with prefix variants); fall back to direct column read
  const fp = (row.field_provenance ?? null) as Record<
    string,
    { value?: unknown; source_excerpt?: string } | undefined
  > | null;
  if (fp) {
    for (const key of [fieldName, `in_${fieldName}`]) {
      const entry = fp[key];
      if (entry && entry.value !== undefined && entry.value !== null) {
        return {
          value: entry.value,
          excerpts: [{
            user_id_hash: actorUserId,
            excerpt: entry.source_excerpt ?? null,
            document_ref: row.id as string,
            recorded_at: new Date().toISOString(),
          }],
        };
      }
    }
  }

  // Direct column fallback — map field names to actual columns
  const colMap: Record<string, unknown> = {
    copay: row.in_copay,
    coinsurance: row.in_coinsurance,
    deductible_applies: row.in_deductible_applies,
    is_covered: row.covered,
    requires_prior_auth: row.prior_auth_required,
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
  const variants = [fieldName, `in_${fieldName}`];
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

  // S102 admin path: auto-expand per-service candidates from plan_covered_services.
  // process-plan.ts's derivePromotionCandidatesFromHaikuResult only produces
  // per-service candidates from the SBC parser path (VotedParseSBCResult);
  // plan_doc parser path passes null → only 7 plan-identity candidates pass
  // through. For admin cold-start to populate canonical_plan_services, we need
  // per-service candidates regardless. Query the actor's plan_covered_services
  // rows and synthesize per-service candidates so the loop below fires
  // apply_promotion_event for each.
  let effectiveCandidates = input.candidates;
  if (actorIsAdmin && input.actorUserId) {
    const expanded = await expandAdminPerServiceCandidates(
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
    const { serviceSlug, fieldName } = candidate;

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
      if (attestValue === null || attestValue === undefined) {
        const direct = serviceSlug === null
          ? await readAdminPlanIdentityValue(supabase, input.actorUserId!, input.canonicalPlanId, fieldName)
          : await readAdminPerServiceValue(supabase, input.actorUserId!, input.canonicalPlanId, serviceSlug, fieldName);
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
        input.actorUserId,
        "admin_override",
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
        input.actorUserId,
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
        input.actorUserId,
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

  return result;
}
