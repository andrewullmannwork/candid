/**
 * CF-40 v4 (Ing-D.0c) — Layer 4 invalidation: slow-drift detection.
 *
 * Per Subplan §2.7(a):
 *
 *   Per (canonical_plan_id, document_type):
 *     IF divergence_rate_30d > 0.3 AND divergent_user_count_30d >= 3:
 *       SET re_baseline_required[doc_type] = TRUE   (clears doctype_promoted)
 *       Write canonical_invalidation_events (Pattern 1 #14 audit)
 *
 * Design (Ing-D.0c critical review — Session 158):
 *   - BASELINE = the canonical's SERVED identity values (`canonical_plans` typed
 *     cols). Drift = "recent uploads increasingly disagree with what we serve."
 *     Always-populated + doc-type-agnostic. NOTE the column-name skew:
 *     canonical_haiku_extractions.field_name uses the `in_`-prefixed name
 *     (`in_deductible_individual`); canonical_plans denormalizes the served value
 *     under the UN-prefixed column (`deductible_individual`) — see
 *     apply_promotion_event (mig 129). SLOW_DRIFT_IDENTITY_FIELDS maps the pair.
 *   - DENOMINATOR = distinct email+phone-VERIFIED users only (Pattern 1 #15 DoS
 *     defense): an unverified-upload spam campaign must not be able to force a
 *     re-baseline (which now RECOVERS, so a forced re-baseline is a real attack
 *     surface). Mirrors gatherLayer3Inputs corroboration gating.
 *   - PER-FIELD, max-drift drives the (canonical, doc_type) signal: catches a
 *     single-field open-enrollment shift (e.g. deductible moved, OOP didn't) that
 *     a tuple-AND would miss, and is diagnostic (we record which field). Per-
 *     service drift is Phase 2+ (canonical_drift_events is keyed per-doc-type).
 *   - re_baseline_required is a SMART-SKIP gate, NOT a contribution gate (the
 *     recorder lets a re-baselining canonical rebuild) — see record-parse-event.ts.
 *
 * Wired from `recordParseEventV4` (record-parse-event.ts) post-Layer-3, FLAG-ON
 * only. Non-fatal: every write is wrapped; this never throws into the recorder.
 *
 * NOT in Ing-D.0c-i (deferred to D.0c-ii): rapid-change (§2.7b) + verification
 * mode (§2.7c). Both key off the "was this a forced re-parse?" signal (not in the
 * recorder's context — lives upstream in shouldSkipExtraction) and the §2.7c
 * 'drift' resolution feeds rapid-change.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { SLOW_DRIFT } from "./scale-thresholds";
import type { ValidityGateFailure } from "./types";
import type { PlanDocType } from "@/lib/parser/doctype-expected-counts";

type SupabaseClient = ReturnType<typeof createServerClient>;

/**
 * Ing-D.0c — re_baseline_required is a SMART-SKIP gate, NOT a contribution gate.
 * A parse CONTRIBUTES to Layer 2 weight + Layer 3 coverage iff it has no genuine
 * QUALITY failure — i.e. every failure (if any) is `canonical_re_baseline_required`.
 * Single source of truth for the split; record-parse-event.ts uses this so a
 * re-baselining canonical can REBUILD (otherwise the gate that forces re-extraction
 * would also block the contribution needed to clear it — a permanent deadlock).
 */
export function contributesUnderLayer1(failureReasons: ValidityGateFailure[]): boolean {
  return failureReasons.every((r) => r === "canonical_re_baseline_required");
}

/**
 * The plan-identity scalars slow-drift watches — the same tuple as
 * HaikuPlanIdentityValues (extraction-dedup.ts), the Layer 3(b) supermajority,
 * and the v3 per-hash stability comparison. `extractionField` is the
 * canonical_haiku_extractions.field_name (in_-prefixed); `canonicalColumn` is the
 * canonical_plans served-value column (un-prefixed).
 */
export const SLOW_DRIFT_IDENTITY_FIELDS = [
  { extractionField: "in_deductible_individual", canonicalColumn: "deductible_individual" },
  { extractionField: "in_deductible_family", canonicalColumn: "deductible_family" },
  { extractionField: "in_oop_max_individual", canonicalColumn: "oop_max_individual" },
  { extractionField: "in_oop_max_family", canonicalColumn: "oop_max_family" },
] as const;

/**
 * docType -> canonical_haiku_extractions.parser_kind. education_doc writes no
 * cite-grade extractions + is bonus-only (Subplan §2.5) -> no slow-drift.
 */
export function docTypeToParserKind(
  docType: PlanDocType,
): "sbc" | "eoc" | "plan_doc" | null {
  if (docType === "sbc") return "sbc";
  if (docType === "eoc") return "eoc";
  if (docType === "plan_document") return "plan_doc";
  return null; // education_doc
}

// ── PURE core (unit-testable, no IO) ─────────────────────────────────────────

export interface DriftExtractionRow {
  /** in_-prefixed field name (matches SLOW_DRIFT_IDENTITY_FIELDS.extractionField). */
  extractionField: string;
  userId: string;
  value: number | null;
  createdAt: string;
}

export interface SlowDriftComputeArgs {
  /** 30d extractions, ALREADY filtered to verified users (caller gates). */
  rows: DriftExtractionRow[];
  /** served baseline keyed by in_-prefixed extractionField; null = no baseline. */
  baseline: Record<string, number | null>;
}

export interface SlowDriftResult {
  /** [0,1] — the max-divergence field's divergent-user rate. */
  divergenceRate: number;
  /** that field's divergent distinct-user count. */
  divergentUserCount: number;
  /** distinct users in window for that field. */
  totalUserCount: number;
  /** rate > 0.3 AND count >= 3 (SLOW_DRIFT thresholds). */
  triggered: boolean;
  /** the in_-prefixed field driving the signal (null = no field had a baseline+data). */
  worstField: string | null;
  baselineValue: number | null;
  /** plurality divergent value among divergent users (for the audit event). */
  divergentValue: number | null;
}

/**
 * Compute slow-drift over the 30d window. Per field: take the LATEST value per
 * distinct user, count users whose value diverges from the served baseline, and
 * let the highest divergent-user RATE field drive the signal. Pure.
 */
export function computeSlowDrift(args: SlowDriftComputeArgs): SlowDriftResult {
  const { rows, baseline } = args;

  // Latest value per (field, user).
  const latest = new Map<string, DriftExtractionRow>();
  for (const r of rows) {
    if (r.value === null) continue;
    const key = `${r.extractionField}|${r.userId}`;
    const prev = latest.get(key);
    if (!prev || new Date(r.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
      latest.set(key, r);
    }
  }

  let best: SlowDriftResult = {
    divergenceRate: 0,
    divergentUserCount: 0,
    totalUserCount: 0,
    triggered: false,
    worstField: null,
    baselineValue: null,
    divergentValue: null,
  };

  for (const { extractionField } of SLOW_DRIFT_IDENTITY_FIELDS) {
    const base = baseline[extractionField];
    if (base === null || base === undefined) continue; // no baseline -> can't assess drift

    const usersForField: number[] = [];
    const prefix = `${extractionField}|`;
    for (const [key, r] of latest) {
      if (key.startsWith(prefix) && r.value !== null) usersForField.push(r.value);
    }
    const total = usersForField.length;
    if (total === 0) continue;

    const divergentVals = usersForField.filter((v) => !valuesEqual(v, base));
    const divergentCount = divergentVals.length;
    const rate = divergentCount / total;

    // Pick the highest-rate field; tie-break on higher divergent count.
    const better =
      rate > best.divergenceRate ||
      (rate === best.divergenceRate && divergentCount > best.divergentUserCount);
    if (better) {
      best = {
        divergenceRate: round3(rate),
        divergentUserCount: divergentCount,
        totalUserCount: total,
        triggered:
          rate > SLOW_DRIFT.divergenceRate30dThreshold &&
          divergentCount >= SLOW_DRIFT.divergentUserCount30dThreshold,
        worstField: extractionField,
        baselineValue: base,
        divergentValue: pluralityValue(divergentVals),
      };
    }
  }

  return best;
}

/** Identity scalars are whole-dollar amounts; exact compare after numeric coercion. */
function valuesEqual(a: number, b: number): boolean {
  return a === b;
}

/** Most-frequent value among the divergent set (the candidate challenger value). */
function pluralityValue(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let bestV: number | null = null;
  let bestC = 0;
  for (const [v, c] of counts) {
    if (c > bestC) {
      bestC = c;
      bestV = v;
    }
  }
  return bestV;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Coerce a JSONB extracted_value to a number (identity scalars). */
export function coerceScalar(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── IO wrapper ───────────────────────────────────────────────────────────────

export interface DetectSlowDriftResult {
  evaluated: boolean;
  triggered: boolean;
  divergenceRate: number;
  divergentUserCount: number;
  worstField: string | null;
  notes: string[];
}

/**
 * Detect slow-drift for a (canonical, doc_type) over the rolling 30d window.
 *
 * ALWAYS writes a canonical_drift_events telemetry row when there is data to
 * evaluate (triggered_re_baseline distinguishes fire vs non-fire — Ship Gate G7).
 * On FIRE: sets re_baseline_required=TRUE + doctype_promoted=FALSE (un-promote the
 * drifted doc-type) on canonical_doctype_promotion_state + writes
 * canonical_invalidation_events('slow_drift_invalidation') with the pre-drift
 * baseline + challenger value. Re-extraction is then forced by the re_baseline
 * smart-skip gate; the rebuild RECOVERS via the recorder's reset loop.
 *
 * Non-fatal: every write is wrapped — this must never break the v3/v4 recorder.
 */
export async function detectSlowDrift(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  now: Date,
): Promise<DetectSlowDriftResult> {
  const notes: string[] = [];
  const noop = (note: string): DetectSlowDriftResult => ({
    evaluated: false,
    triggered: false,
    divergenceRate: 0,
    divergentUserCount: 0,
    worstField: null,
    notes: [note],
  });

  const parserKind = docTypeToParserKind(docType);
  if (!parserKind) return noop("education_doc — no slow-drift");

  // 1. Served baseline from canonical_plans (UN-prefixed typed cols).
  const { data: canon } = await supabase
    .from("canonical_plans")
    .select(
      "deductible_individual, deductible_family, oop_max_individual, oop_max_family",
    )
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (!canon) return noop("no canonical row");

  const baseline: Record<string, number | null> = {};
  for (const f of SLOW_DRIFT_IDENTITY_FIELDS) {
    baseline[f.extractionField] =
      (canon[f.canonicalColumn as keyof typeof canon] as number | null) ?? null;
  }

  // 2. 30d extractions of the identity fields (service_slug NULL = plan-identity).
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fieldNames = SLOW_DRIFT_IDENTITY_FIELDS.map((f) => f.extractionField);
  const { data: extractions } = await supabase
    .from("canonical_haiku_extractions")
    .select("field_name, user_id, extracted_value, created_at")
    .eq("canonical_plan_id", canonicalPlanId)
    .eq("parser_kind", parserKind)
    .is("service_slug", null)
    .in("field_name", fieldNames)
    .gte("created_at", windowStart);
  if (!extractions || extractions.length === 0) return noop("no 30d extractions");

  // 3. Verified-user gate (Pattern 1 #15): only email+phone-verified uploaders
  //    count toward drift (defends against unverified-spam forced re-baseline).
  const userIds = [...new Set(extractions.map((e) => e.user_id as string))];
  const { data: users } = await supabase
    .from("users")
    .select("id, email_verified, phone_verified")
    .in("id", userIds);
  const verified = new Set(
    (users ?? [])
      .filter((u) => u.email_verified === true && u.phone_verified === true)
      .map((u) => u.id as string),
  );

  const rows: DriftExtractionRow[] = extractions
    .filter((e) => verified.has(e.user_id as string))
    .map((e) => ({
      extractionField: e.field_name as string,
      userId: e.user_id as string,
      value: coerceScalar(e.extracted_value),
      createdAt: e.created_at as string,
    }));
  if (rows.length === 0) return noop("no verified-user extractions in 30d window");

  const result = computeSlowDrift({ rows, baseline });

  // 4. ALWAYS write the telemetry row (G7 fire + non-fire).
  try {
    await supabase.from("canonical_drift_events").insert({
      canonical_plan_id: canonicalPlanId,
      document_type: docType,
      divergence_rate_30d: result.divergenceRate,
      divergent_user_count_30d: result.divergentUserCount,
      triggered_re_baseline: result.triggered,
    });
  } catch {
    notes.push("canonical_drift_events insert skipped (non-fatal)");
  }

  // 5. On FIRE: invalidate (set re_baseline + un-promote) + Pattern 1 #14 audit.
  if (result.triggered) {
    try {
      await supabase
        .from("canonical_doctype_promotion_state")
        .update({ re_baseline_required: true, doctype_promoted: false })
        .eq("canonical_plan_id", canonicalPlanId)
        .eq("document_type", docType);
      await supabase.from("canonical_invalidation_events").insert({
        canonical_plan_id: canonicalPlanId,
        document_type: docType,
        event_type: "slow_drift_invalidation",
        baseline_value_jsonb: result.baselineValue,
        divergent_value_jsonb: result.divergentValue,
      });
      notes.push(
        `SLOW-DRIFT FIRED on ${result.worstField} (rate=${result.divergenceRate}, divergent_users=${result.divergentUserCount}/${result.totalUserCount}) -> re_baseline_required=TRUE, doctype un-promoted`,
      );
    } catch {
      notes.push("slow-drift invalidation write skipped (non-fatal)");
    }
  }

  return {
    evaluated: true,
    triggered: result.triggered,
    divergenceRate: result.divergenceRate,
    divergentUserCount: result.divergentUserCount,
    worstField: result.worstField,
    notes,
  };
}
