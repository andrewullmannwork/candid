/**
 * Ing-A (S127) — Post-promotion auto-reparse triage.
 *
 * Sits at the end of `commitUploadAndEvaluateCorroboration` and, for each
 * candidate evaluated this session, reads the actor's field_provenance from
 * the appropriate row + applies the triage rule:
 *
 *    reparse if (value IS NULL)
 *           OR (source_excerpt_verified <> 'verified')
 *           OR (haiku_confidence < 0.5)
 *
 * Triggered fields are dispatched in ONE batched Haiku call per upload (via
 * `reparseFieldsBatch`) — cost-optimized peer of the user-triggered single-
 * field reparse path. Per-field telemetry written to
 * `auto_reparse_field_frequencies` for Phase 6+ threshold calibration.
 *
 * SAFETY GATES (cumulative):
 *   1. `auto_reparse_enabled` feature flag must be ON (inlined check; default OFF)
 *   2. `input.documentId` must be present (telemetry attribution + D3 cap query)
 *   3. Per-upload cap: ≤3 prior fires for this `documents.id` in
 *      `auto_reparse_field_frequencies` (D3 lock at S126)
 *   4. Per-batch cost cap + per-plan-per-day cap + 1-per-minute rate-limit
 *      preserved by `reparseFieldsBatch` (shared with user-triggered path)
 *
 * INVARIANT: Pattern P-2 hard rule — `haiku_confidence` is METADATA ONLY and
 * is read ONLY here to drive the triage decision; never blended into the
 * stored confidence score.
 *
 * RETURN: triage trace folded into `CommitAndEvaluateResult.autoReparseTrace`
 * for caller observability; doesn't mutate the promotion trace.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { reparseFieldsBatch } from "../plan/reparse-fields-batch";
import { loadDecorationContext, type DecorationContext } from "../plan/analyze-decoration";
import type { FieldProvenanceEntry } from "./field-categories";
import type {
  CommitAndEvaluateTraceEntry,
  FieldEvaluationCandidate,
} from "./commit-and-evaluate";

type SupabaseClient = ReturnType<typeof createServerClient>;

const PER_UPLOAD_FIRE_CAP = 3;
const TRIAGE_CONFIDENCE_THRESHOLD = 0.5;

export type TriageReason =
  | "null_value"
  | "unverified_excerpt"
  | "low_confidence";

export type TriageOutcome =
  | "reparse_changed_value"
  | "reparse_confirmed_null"
  | "reparse_no_change"
  | "reparse_skipped_cap"
  | "reparse_skipped_no_sections"
  | "reparse_failed";

export interface AutoReparseTraceEntry {
  serviceSlug: string | null;
  fieldName: string;
  triggerReason: TriageReason;
  confidenceAtTrigger: number | null;
  outcome: TriageOutcome;
  costAttributedUsd?: number;
  finalVerifiedState?: string;
}

export interface AutoReparseTriageInput {
  canonicalPlanId: string;
  actorUserId: string;
  /** documents.id — required for telemetry attribution + D3 cap query. */
  documentId: string;
  /** Candidates evaluated in this commit cycle (post-promotion or no-change). */
  candidates: FieldEvaluationCandidate[];
  /** Trace from commit-and-evaluate; informational (not consumed by triage today). */
  trace: CommitAndEvaluateTraceEntry[];
}

export interface AutoReparseTriageResult {
  /** Trace entries — one per field that the triage evaluated (whether fired or skipped). */
  trace: AutoReparseTraceEntry[];
  /** Total Haiku spend across the batched reparse call. */
  totalCostUsd: number;
  /** Was the triage skipped entirely (flag OFF, cap hit, etc.). */
  skippedReason?: "flag_off" | "no_document_id" | "no_actor_plan" | "cap_exhausted" | "no_candidates";
}

/**
 * Reads field_provenance for each candidate, applies triage rule, dispatches
 * batched reparse for triggered fields, writes per-field telemetry, returns
 * trace for inclusion in CommitAndEvaluateResult.
 *
 * Idempotent on no-op paths (flag off / cap exhausted / no candidates).
 */
export async function triageAutoReparse(
  supabase: SupabaseClient,
  input: AutoReparseTriageInput,
): Promise<AutoReparseTriageResult> {
  if (!input.documentId) {
    return { trace: [], totalCostUsd: 0, skippedReason: "no_document_id" };
  }
  if (input.candidates.length === 0) {
    return { trace: [], totalCostUsd: 0, skippedReason: "no_candidates" };
  }

  // ── Gate 1: flag check ──────────────────────────────────────────────────
  if (!(await isAutoReparseEnabled(supabase))) {
    return { trace: [], totalCostUsd: 0, skippedReason: "flag_off" };
  }

  // ── Gate 2: per-upload fire cap (D3 lock) ────────────────────────────────
  const { count: priorFires } = await supabase
    .from("auto_reparse_field_frequencies")
    .select("id", { count: "exact", head: true })
    .eq("document_id", input.documentId);
  const priorCount = priorFires ?? 0;
  if (priorCount >= PER_UPLOAD_FIRE_CAP) {
    return { trace: [], totalCostUsd: 0, skippedReason: "cap_exhausted" };
  }
  const remainingCap = PER_UPLOAD_FIRE_CAP - priorCount;

  // ── Resolve actor's insurance_plans row (Pattern 1 #14 user-scoped) ──────
  // Select plan-identity columns inline so the null_value triage check reads
  // the actual column values without an additional round-trip. Static SELECT
  // string for supabase-js compile-time typing.
  const { data: actorPlan } = await supabase
    .from("insurance_plans")
    .select(
      "id, field_provenance, plan_name, insurer_name, plan_type, plan_year, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family, out_deductible_individual, out_oop_max_individual",
    )
    .eq("user_id", input.actorUserId)
    .eq("canonical_plan_id", input.canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!actorPlan?.id) {
    return { trace: [], totalCostUsd: 0, skippedReason: "no_actor_plan" };
  }
  const planRowId = actorPlan.id as string;
  const planFp = (actorPlan.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {};
  const planColumns = actorPlan as unknown as Record<string, unknown>;

  // ── Cache plan_covered_services field_provenance + columns per slug ──────
  // SELECT * keeps the cache flexible if new reparse-eligible columns are
  // added to the allow-list without needing to edit this helper.
  interface PcsCacheEntry {
    fp: Record<string, FieldProvenanceEntry> | null;
    columns: Record<string, unknown>;
  }
  const slugToPcs = new Map<string, PcsCacheEntry | null>();
  const fetchPcs = async (slug: string): Promise<PcsCacheEntry | null> => {
    if (slugToPcs.has(slug)) return slugToPcs.get(slug) ?? null;
    const { data: pcs } = await supabase
      .from("plan_covered_services")
      .select("*, service_catalog!inner(slug)")
      .eq("insurance_plan_id", planRowId)
      .eq("service_catalog.slug", slug)
      .maybeSingle();
    if (!pcs) {
      slugToPcs.set(slug, null);
      return null;
    }
    const fp =
      ((pcs as Record<string, unknown>).field_provenance as
        | Record<string, FieldProvenanceEntry>
        | null) ?? null;
    const entry: PcsCacheEntry = { fp, columns: pcs as Record<string, unknown> };
    slugToPcs.set(slug, entry);
    return entry;
  };

  // ── Triage rule per candidate ────────────────────────────────────────────
  interface TriagedField {
    candidate: FieldEvaluationCandidate;
    triggerReason: TriageReason;
    confidenceAtTrigger: number | null;
  }
  const triaged: TriagedField[] = [];

  for (const candidate of input.candidates) {
    let entry: FieldProvenanceEntry | undefined;
    let columnValue: unknown = null;
    if (candidate.serviceSlug) {
      const pcs = await fetchPcs(candidate.serviceSlug);
      entry = pcs?.fp?.[candidate.fieldName];
      columnValue = pcs?.columns[candidate.fieldName] ?? null;
    } else {
      entry = planFp[candidate.fieldName];
      columnValue = planColumns[candidate.fieldName] ?? null;
    }

    const valueIsNull = columnValue === null || columnValue === undefined;
    const verified = entry?.source_excerpt_verified;
    const haikuConfidence =
      typeof entry?.haiku_confidence === "number" ? entry.haiku_confidence : null;

    // Triage evaluated in order; first match wins.
    // Entry-undefined cases: triage may still fire (e.g. null column with no
    // provenance entry → null_value). The downstream batched reparse will
    // bail with reparse_skipped_no_sections for entries lacking
    // searched_sections — telemetry records that as a real outcome rather
    // than silently dropping the field.
    let reason: TriageReason | null = null;
    let confidenceAtTrigger: number | null = null;
    if (valueIsNull) {
      reason = "null_value";
    } else if (verified !== undefined && verified !== "verified") {
      reason = "unverified_excerpt";
    } else if (
      haikuConfidence !== null &&
      haikuConfidence < TRIAGE_CONFIDENCE_THRESHOLD
    ) {
      reason = "low_confidence";
      confidenceAtTrigger = haikuConfidence;
    }

    if (reason) {
      triaged.push({ candidate, triggerReason: reason, confidenceAtTrigger });
    }
  }

  if (triaged.length === 0) {
    return { trace: [], totalCostUsd: 0 };
  }

  // Apply remaining cap — only the first `remainingCap` triaged fields fire;
  // the rest get a "reparse_skipped_cap" telemetry row.
  const willFire = triaged.slice(0, remainingCap);
  const willSkipForCap = triaged.slice(remainingCap);

  // ── Dispatch batched reparse for the firing set ──────────────────────────
  // Decoration context is informational only for auto-reparse (caller doesn't
  // consume decoratedValue from batch result). Pass null userEmail so flag check
  // resolves against global state — auto-reparse runs at parser-time, not as a
  // per-user request. Fall back to safe defaults when flag is OFF.
  const loaded = await loadDecorationContext(supabase, null, {
    canonical_plan_id: input.canonicalPlanId,
  });
  const decorationContext: DecorationContext = loaded ?? {
    multiSourceThreshold: 3,
    canonicalSourceCount: 1,
  };
  const batchResult = await reparseFieldsBatch(
    supabase,
    input.actorUserId,
    planRowId,
    willFire.map((t) => ({
      fieldName: t.candidate.fieldName,
      serviceSlug: t.candidate.serviceSlug ?? undefined,
    })),
    decorationContext,
  );

  // ── Build trace + write telemetry rows ───────────────────────────────────
  const traceEntries: AutoReparseTraceEntry[] = [];
  const telemetryRows: Record<string, unknown>[] = [];

  // Map per-field results back to triaged context for telemetry.
  for (const t of willFire) {
    const matchedResult = batchResult.perField.find(
      (r) =>
        r.fieldName === t.candidate.fieldName &&
        (r.serviceSlug ?? null) === (t.candidate.serviceSlug ?? null),
    );

    let outcome: TriageOutcome;
    let costAttributedUsd: number | undefined;
    let finalVerifiedState: string | undefined;

    if (batchResult.batchError) {
      // Batch was rejected before dispatch — map to closest outcome.
      outcome =
        batchResult.batchError === "no_unsearched_sections"
          ? "reparse_skipped_no_sections"
          : "reparse_failed";
    } else if (!matchedResult) {
      // Eligibility filter dropped this field — treat as skipped no-sections.
      outcome = "reparse_skipped_no_sections";
    } else {
      outcome = matchedResult.outcome as TriageOutcome;
      costAttributedUsd = matchedResult.costAttributedUsd;
      finalVerifiedState = matchedResult.finalVerifiedState;
    }

    traceEntries.push({
      serviceSlug: t.candidate.serviceSlug,
      fieldName: t.candidate.fieldName,
      triggerReason: t.triggerReason,
      confidenceAtTrigger: t.confidenceAtTrigger,
      outcome,
      costAttributedUsd,
      finalVerifiedState,
    });

    telemetryRows.push({
      canonical_plan_id: input.canonicalPlanId,
      document_id: input.documentId,
      field_name: t.candidate.fieldName,
      service_slug: t.candidate.serviceSlug,
      trigger_reason: t.triggerReason,
      confidence_at_trigger: t.confidenceAtTrigger,
      reparse_outcome: outcome,
      reparse_cost_usd: costAttributedUsd ?? null,
    });
  }

  for (const t of willSkipForCap) {
    traceEntries.push({
      serviceSlug: t.candidate.serviceSlug,
      fieldName: t.candidate.fieldName,
      triggerReason: t.triggerReason,
      confidenceAtTrigger: t.confidenceAtTrigger,
      outcome: "reparse_skipped_cap",
    });
    telemetryRows.push({
      canonical_plan_id: input.canonicalPlanId,
      document_id: input.documentId,
      field_name: t.candidate.fieldName,
      service_slug: t.candidate.serviceSlug,
      trigger_reason: t.triggerReason,
      confidence_at_trigger: t.confidenceAtTrigger,
      reparse_outcome: "reparse_skipped_cap",
      reparse_cost_usd: null,
    });
  }

  // Single bulk insert for all telemetry rows.
  if (telemetryRows.length > 0) {
    const { error: insErr } = await supabase
      .from("auto_reparse_field_frequencies")
      .insert(telemetryRows);
    if (insErr) {
      console.error("[auto-reparse-triage] telemetry insert failed:", insErr);
      // Don't fail the triage — the reparse already ran; telemetry is observability.
    }
  }

  return {
    trace: traceEntries,
    totalCostUsd: batchResult.totalCostUsd,
  };
}

/**
 * Reads `auto_reparse_enabled` flag from feature_flag_rules. Default false
 * (fail-closed) on missing row or read error.
 */
async function isAutoReparseEnabled(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase
    .from("feature_flag_rules")
    .select("enabled")
    .eq("flag_key", "auto_reparse_enabled")
    .maybeSingle();
  if (error || !data) return false;
  return data.enabled === true;
}
