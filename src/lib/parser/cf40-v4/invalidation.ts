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
 * Ing-D.0c-ii ADDS (below detectSlowDrift): rapid-change (§2.7b — scale-aware
 * convergence) + verification-mode (§2.7c — divergent forced re-parse opens a
 * canonical-wide double-check; consecutive agreement on the challenger confirms
 * drift, a single divergence is noise). Both key off the forced-reparse reason,
 * now plumbed `shouldSkipExtraction → documents.cf40_forced_reparse_reason →
 * recordParseEventV4` (mig 141).
 */

import type { createServerClient } from "@/lib/supabase/server";
import {
  SLOW_DRIFT,
  RAPID_CHANGE_THRESHOLDS,
  IDENTITY_PLAUSIBILITY,
  type RapidChangeThresholds,
} from "./scale-thresholds";
import { getScaleTier, type ValidityGateFailure, type ForcedReparseReason } from "./types";
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

// ═══════════════════════════════════════════════════════════════════════════
// Ing-D.0c-ii — shared identity-tuple helpers (rapid-change + verification-mode)
// ═══════════════════════════════════════════════════════════════════════════

/** The 4 plan-identity scalars, in_-prefixed (mirrors extraction-dedup HaikuPlanIdentityValues). */
export interface IdentityTuple {
  in_deductible_individual: number | null;
  in_deductible_family: number | null;
  in_oop_max_individual: number | null;
  in_oop_max_family: number | null;
}

/** Null-safe equality over the 4 identity scalars (mirrors extraction-dedup planIdentityEqual). */
export function identityTupleEqual(a: IdentityTuple | null, b: IdentityTuple | null): boolean {
  if (!a || !b) return false;
  return (
    (a.in_deductible_individual ?? null) === (b.in_deductible_individual ?? null) &&
    (a.in_deductible_family ?? null) === (b.in_deductible_family ?? null) &&
    (a.in_oop_max_individual ?? null) === (b.in_oop_max_individual ?? null) &&
    (a.in_oop_max_family ?? null) === (b.in_oop_max_family ?? null)
  );
}

/** value within [base×min, base×max]; a $0/negative baseline defers to count/diversity gates. */
export function withinPlausibility(value: number, base: number, min: number, max: number): boolean {
  if (base <= 0) return true;
  return value >= base * min && value <= base * max;
}

/**
 * Load the canonical's SERVED identity baseline (canonical_plans typed cols),
 * keyed by the in_-prefixed extractionField (per SLOW_DRIFT_IDENTITY_FIELDS).
 * Returns null when the canonical row is missing.
 */
export async function loadServedBaseline(
  supabase: SupabaseClient,
  canonicalPlanId: string,
): Promise<Record<string, number | null> | null> {
  const { data: canon } = await supabase
    .from("canonical_plans")
    .select("deductible_individual, deductible_family, oop_max_individual, oop_max_family")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (!canon) return null;
  const baseline: Record<string, number | null> = {};
  for (const f of SLOW_DRIFT_IDENTITY_FIELDS) {
    baseline[f.extractionField] =
      (canon[f.canonicalColumn as keyof typeof canon] as number | null) ?? null;
  }
  return baseline;
}

/** A served baseline (in_-keyed record) as an IdentityTuple for tuple compares. */
function baselineToTuple(baseline: Record<string, number | null>): IdentityTuple {
  return {
    in_deductible_individual: baseline.in_deductible_individual ?? null,
    in_deductible_family: baseline.in_deductible_family ?? null,
    in_oop_max_individual: baseline.in_oop_max_individual ?? null,
    in_oop_max_family: baseline.in_oop_max_family ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ing-D.0c-ii — §2.7(b) rapid-change detection
// ═══════════════════════════════════════════════════════════════════════════

/** Measured diversity among the converging users; a null field = unmeasurable. */
export interface DiversityMeasure {
  ipBlocks: number | null;
  asns: number | null;
  emailDomains: number | null;
}

export interface RapidChangeComputeArgs {
  /** in-window, verified-user extractions (the caller gates both). */
  rows: DriftExtractionRow[];
  /** served baseline keyed by in_-prefixed extractionField. */
  baseline: Record<string, number | null>;
  thresholds: RapidChangeThresholds;
  diversity: DiversityMeasure;
}

export interface RapidChangeResult {
  /** at least one field had a baseline + a non-baseline challenger to assess. */
  evaluated: boolean;
  /** 'auto_fire' re-baselines; 'admin_review' queues; 'none' = no actionable signal. */
  disposition: "none" | "auto_fire" | "admin_review";
  convergenceRate: number;
  convergingUserCount: number;
  totalUserCount: number;
  worstField: string | null;
  baselineValue: number | null;
  challengerValue: number | null;
  /** distinct user_ids converging on the challenger (audit + admin queue). */
  convergingUserIds: string[];
  plausible: boolean;
  diversityMet: boolean;
  diversityMeasurable: boolean;
}

/**
 * §2.7(b) rapid-change: within the scale-aware window, distinct verified users
 * CONVERGING on a single plausible non-baseline challenger. Unlike slow-drift
 * (divergence RATE over 30d), this is convergence COUNT over a short window —
 * the signature of a coordinated shift (a real open-enrollment change OR an
 * attack). Plausibility + diversity + cold-start admin-review separate the two:
 *
 *   countMet ∧ plausible ∧ cold_start                    → admin_review
 *   countMet ∧ plausible ∧ (diversity unmeasurable|unmet) → admin_review (conservative)
 *   countMet ∧ plausible ∧ diversity met                  → auto_fire
 *   else                                                  → none
 *
 * Conservative-by-design: NEVER auto-un-promotes a Verified canonical without a
 * diverse, plausible, scale-sufficient convergence. Pure.
 */
export function computeRapidChange(args: RapidChangeComputeArgs): RapidChangeResult {
  const { rows, baseline, thresholds, diversity } = args;

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

  let best: RapidChangeResult = {
    evaluated: false,
    disposition: "none",
    convergenceRate: 0,
    convergingUserCount: 0,
    totalUserCount: 0,
    worstField: null,
    baselineValue: null,
    challengerValue: null,
    convergingUserIds: [],
    plausible: false,
    diversityMet: false,
    diversityMeasurable: false,
  };

  for (const { extractionField } of SLOW_DRIFT_IDENTITY_FIELDS) {
    const base = baseline[extractionField];
    if (base === null || base === undefined) continue;

    const prefix = `${extractionField}|`;
    const perUser: Array<{ userId: string; value: number }> = [];
    for (const [key, r] of latest) {
      if (key.startsWith(prefix) && r.value !== null) perUser.push({ userId: r.userId, value: r.value });
    }
    const total = perUser.length;
    if (total === 0) continue;

    // Challenger = plurality NON-baseline value; converging users agree on it.
    const nonBaseline = perUser.filter((u) => !valuesEqual(u.value, base));
    if (nonBaseline.length === 0) continue; // everyone agrees with baseline — no change
    const challenger = pluralityValue(nonBaseline.map((u) => u.value));
    if (challenger === null) continue;
    const converging = nonBaseline.filter((u) => valuesEqual(u.value, challenger));
    const convergingCount = converging.length;
    const rate = convergingCount / total;

    // Field with the MOST converging users drives the signal (tie → higher rate).
    const better =
      convergingCount > best.convergingUserCount ||
      (convergingCount === best.convergingUserCount && rate > best.convergenceRate);
    if (better) {
      best = {
        ...best,
        evaluated: true,
        convergenceRate: round3(rate),
        convergingUserCount: convergingCount,
        totalUserCount: total,
        worstField: extractionField,
        baselineValue: base,
        challengerValue: challenger,
        convergingUserIds: converging.map((u) => u.userId),
      };
    }
  }

  if (!best.evaluated) return best;

  const countMet = best.convergingUserCount >= thresholds.distinctUsersInWindow;
  const plausible =
    best.challengerValue !== null &&
    best.baselineValue !== null &&
    withinPlausibility(
      best.challengerValue,
      best.baselineValue,
      thresholds.plausibilityRangeMin,
      thresholds.plausibilityRangeMax,
    );

  const diversityRequired =
    thresholds.ipBlocks !== null || thresholds.asns !== null || thresholds.emailDomains !== null;
  const diversityMeasurable =
    !diversityRequired ||
    ((thresholds.ipBlocks === null || diversity.ipBlocks !== null) &&
      (thresholds.asns === null || diversity.asns !== null) &&
      (thresholds.emailDomains === null || diversity.emailDomains !== null));
  const diversityMet =
    !diversityRequired ||
    ((thresholds.ipBlocks === null || (diversity.ipBlocks ?? 0) >= thresholds.ipBlocks) &&
      (thresholds.asns === null || (diversity.asns ?? 0) >= thresholds.asns) &&
      (thresholds.emailDomains === null || (diversity.emailDomains ?? 0) >= thresholds.emailDomains));

  let disposition: RapidChangeResult["disposition"] = "none";
  if (countMet && plausible) {
    if (thresholds.requiresAdminReview) disposition = "admin_review"; // cold_start (0-100)
    else if (!diversityMeasurable || !diversityMet) disposition = "admin_review"; // conservative
    else disposition = "auto_fire";
  }

  return { ...best, plausible, diversityMet, diversityMeasurable, disposition };
}

export interface DetectRapidChangeResult {
  evaluated: boolean;
  disposition: "none" | "auto_fire" | "admin_review";
  convergenceRate: number;
  convergingUserCount: number;
  worstField: string | null;
  notes: string[];
}

/**
 * Detect rapid-change for a (canonical, doc_type) over the scale-aware window.
 *
 * ALWAYS writes a canonical_drift_events row (detection_type='rapid_change';
 * triggered_re_baseline distinguishes fire vs non-fire — Ship Gate G7). On
 * auto_fire: re_baseline + un-promote + rapid_change_invalidation. On
 * admin_review: rapid_change_pending_admin_review + a canonical_divergence_review
 * row (divergence_type='unclassified' — admin classifies; no MVP heuristic).
 *
 * Diversity (IP/ASN/email-domain) is NOT collected today → passed null → any
 * small+ convergence conservatively routes to admin_review (cannot confirm
 * diverse-vs-coordinated). Mirrors Layer 3 diversity (fail-closed). Declared
 * abstention: auto_fire is unreachable via this IO path until diversity is
 * plumbed; the pure decision is fixture-locked for all branches. Non-fatal.
 */
export async function detectRapidChange(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  now: Date,
): Promise<DetectRapidChangeResult> {
  const notes: string[] = [];
  const noop = (note: string): DetectRapidChangeResult => ({
    evaluated: false,
    disposition: "none",
    convergenceRate: 0,
    convergingUserCount: 0,
    worstField: null,
    notes: [note],
  });

  const parserKind = docTypeToParserKind(docType);
  if (!parserKind) return noop("education_doc — no rapid-change");

  const baseline = await loadServedBaseline(supabase, canonicalPlanId);
  if (!baseline) return noop("no canonical row");

  // Scale tier from canonical's lifetime extraction count → window + thresholds.
  const { data: canon } = await supabase
    .from("canonical_plans")
    .select("extraction_count")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  const scaleTier = getScaleTier((canon?.extraction_count as number | null) ?? 0);
  const thresholds = RAPID_CHANGE_THRESHOLDS[scaleTier];

  const windowStart = new Date(
    now.getTime() - thresholds.timeWindowDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const fieldNames = SLOW_DRIFT_IDENTITY_FIELDS.map((f) => f.extractionField);
  const { data: extractions } = await supabase
    .from("canonical_haiku_extractions")
    .select("field_name, user_id, extracted_value, created_at")
    .eq("canonical_plan_id", canonicalPlanId)
    .eq("parser_kind", parserKind)
    .is("service_slug", null)
    .in("field_name", fieldNames)
    .gte("created_at", windowStart);
  if (!extractions || extractions.length === 0) return noop("no in-window extractions");

  // Verified-user gate (Pattern 1 #15) — unverified-spam can't force a re-baseline.
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
  if (rows.length === 0) return noop("no verified-user extractions in window");

  const result = computeRapidChange({
    rows,
    baseline,
    thresholds,
    diversity: { ipBlocks: null, asns: null, emailDomains: null }, // not collected — see docstring
  });

  // ALWAYS write telemetry (G7) into the unified Layer-4 sink.
  try {
    await supabase.from("canonical_drift_events").insert({
      canonical_plan_id: canonicalPlanId,
      document_type: docType,
      detection_type: "rapid_change",
      window_days: thresholds.timeWindowDays,
      divergence_rate_30d: result.convergenceRate,
      divergent_user_count_30d: result.convergingUserCount,
      triggered_re_baseline: result.disposition === "auto_fire",
    });
  } catch {
    notes.push("canonical_drift_events (rapid_change) insert skipped (non-fatal)");
  }

  const challengerJsonb = result.worstField
    ? { field: result.worstField, value: result.challengerValue }
    : null;
  const baselineJsonb = result.worstField
    ? { field: result.worstField, value: result.baselineValue }
    : null;

  if (result.disposition === "auto_fire") {
    try {
      await supabase
        .from("canonical_doctype_promotion_state")
        .update({ re_baseline_required: true, doctype_promoted: false })
        .eq("canonical_plan_id", canonicalPlanId)
        .eq("document_type", docType);
      await supabase.from("canonical_invalidation_events").insert({
        canonical_plan_id: canonicalPlanId,
        document_type: docType,
        event_type: "rapid_change_invalidation",
        triggering_user_ids: result.convergingUserIds,
        baseline_value_jsonb: baselineJsonb,
        divergent_value_jsonb: challengerJsonb,
      });
      notes.push(
        `RAPID-CHANGE AUTO-FIRE on ${result.worstField} (converging=${result.convergingUserCount}/${result.totalUserCount}) → re_baseline_required=TRUE`,
      );
    } catch {
      notes.push("rapid-change auto-fire write skipped (non-fatal)");
    }
  } else if (result.disposition === "admin_review") {
    try {
      await supabase.from("canonical_invalidation_events").insert({
        canonical_plan_id: canonicalPlanId,
        document_type: docType,
        event_type: "rapid_change_pending_admin_review",
        triggering_user_ids: result.convergingUserIds,
        baseline_value_jsonb: baselineJsonb,
        divergent_value_jsonb: challengerJsonb,
        admin_disposition: "pending",
      });
      if (result.worstField) {
        await supabase.from("canonical_divergence_review").insert({
          canonical_plan_id: canonicalPlanId,
          document_type: docType,
          field_name: result.worstField,
          minority_value_jsonb: { value: result.challengerValue },
          minority_weight: result.convergingUserCount,
          total_weight: result.totalUserCount,
          contributing_user_ids: result.convergingUserIds,
          divergence_type: "unclassified", // MVP — admin classifies; no auto-heuristic (audit OQ2)
          status: "pending",
        });
      }
      notes.push(
        `RAPID-CHANGE → ADMIN REVIEW on ${result.worstField} (converging=${result.convergingUserCount}; ${thresholds.requiresAdminReview ? "cold-start" : "diversity-unconfirmed"})`,
      );
    } catch {
      notes.push("rapid-change admin-review write skipped (non-fatal)");
    }
  }

  return {
    evaluated: result.evaluated,
    disposition: result.disposition,
    convergenceRate: result.convergenceRate,
    convergingUserCount: result.convergingUserCount,
    worstField: result.worstField,
    notes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ing-D.0c-ii — §2.7(c) verification-mode
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The robustness core (Andrew S159 critical review): a verification re-parse
 * confirms drift ONLY on consecutive AGREEMENT with the stored challenger. A
 * SECOND, DIFFERENT divergent value is the signature of NOISE, not a real change
 * — "any divergence from baseline" would false-re-baseline on it (the
 * catastrophic direction). Matching the served baseline, or a third distinct
 * value, both resolve as noise. Pure.
 */
export function resolveVerificationDecision(
  parse: IdentityTuple,
  challenger: IdentityTuple | null,
): "drift" | "noise" {
  if (challenger && identityTupleEqual(parse, challenger)) return "drift";
  return "noise";
}

/** True iff `parse` diverges from the served baseline on at least one identity field. */
export function tupleDivergesFromBaseline(
  parse: IdentityTuple,
  baseline: Record<string, number | null>,
): boolean {
  return !identityTupleEqual(parse, baselineToTuple(baseline));
}

/** True iff every field where `parse` diverges from baseline is within the plausibility band. */
export function divergingFieldsPlausible(
  parse: IdentityTuple,
  baseline: Record<string, number | null>,
): boolean {
  for (const { extractionField } of SLOW_DRIFT_IDENTITY_FIELDS) {
    const base = baseline[extractionField];
    const val = (parse as unknown as Record<string, number | null>)[extractionField];
    if (base === null || base === undefined || val === null || val === undefined) continue;
    if (valuesEqual(val, base)) continue; // not diverging on this field
    if (!withinPlausibility(val, base, IDENTITY_PLAUSIBILITY.min, IDENTITY_PLAUSIBILITY.max)) {
      return false;
    }
  }
  return true;
}

/** Layer-5 forced reasons OTHER than verification-mode itself — these can OPEN verification. */
const NON_VERIFICATION_FORCED: ReadonlySet<string> = new Set<ForcedReparseReason & string>([
  "admin_upload",
  "statistical_drift_sample",
  "temporal_staleness",
  "admin_attestation_validation",
  "every_5th_smart_skip",
]);

export interface DetectVerificationResult {
  mode: "none" | "open" | "resolve";
  /** resolve → 'drift'|'noise'; open → 'opened'|'no_divergence'|'implausible'; none → reason. */
  outcome: string;
  notes: string[];
}

/**
 * §2.7(c) verification-mode. Canonical-WIDE (mig 086 divergence_pending_verification).
 *
 *   RESOLVE (this parse was forced BY verification mode — Layer 5 trigger #4):
 *     read the open challenger; consecutive AGREEMENT → resolved_drift (re-baseline);
 *     else → resolved_noise (baseline intact). Always clears the flag. Runs even
 *     while re-baselining (it is closing an open round).
 *   OPEN (a NON-verification forced re-parse that diverged PLAUSIBLY from the
 *     SERVED baseline): set divergence_pending_verification=TRUE → the next upload
 *     of ANY doc-type is forced to verify. Suppressed while re-baselining.
 *
 * A `forcedReparseReason` is set ONLY when the orchestrator passed Layers 1-3
 * (stable + promoted + valid) and Layer 5 forced a parse — so "forced + divergent"
 * already means "a canonical we served as settled disagreed with itself." Non-fatal.
 */
export async function detectVerificationMode(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: PlanDocType,
  parse: IdentityTuple,
  forcedReparseReason: ForcedReparseReason | null,
  inReBaselineMode: boolean,
): Promise<DetectVerificationResult> {
  const notes: string[] = [];
  const parserKind = docTypeToParserKind(docType);
  if (!parserKind) return { mode: "none", outcome: "education_doc", notes };

  const baseline = await loadServedBaseline(supabase, canonicalPlanId);
  if (!baseline) return { mode: "none", outcome: "no_canonical", notes };

  // ── RESOLVE ────────────────────────────────────────────────────────────────
  if (forcedReparseReason === "verification_mode") {
    const { data: open } = await supabase
      .from("canonical_invalidation_events")
      .select("divergent_value_jsonb")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("event_type", "verification_mode_triggered")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const challenger = (open?.divergent_value_jsonb as IdentityTuple | null) ?? null;
    const decision = resolveVerificationDecision(parse, challenger);

    // Always clear the canonical-wide flag — this verification round is over.
    try {
      await supabase
        .from("canonical_plans")
        .update({ divergence_pending_verification: false })
        .eq("id", canonicalPlanId);
    } catch {
      notes.push("clear divergence_pending_verification skipped (non-fatal)");
    }

    if (decision === "drift") {
      try {
        await supabase
          .from("canonical_doctype_promotion_state")
          .update({ re_baseline_required: true, doctype_promoted: false })
          .eq("canonical_plan_id", canonicalPlanId)
          .eq("document_type", docType);
        await supabase.from("canonical_invalidation_events").insert({
          canonical_plan_id: canonicalPlanId,
          document_type: docType,
          event_type: "verification_mode_resolved_drift",
          baseline_value_jsonb: baselineToTuple(baseline),
          divergent_value_jsonb: parse,
        });
        notes.push(
          "VERIFICATION RESOLVED → DRIFT (challenger confirmed twice) → re_baseline_required=TRUE",
        );
      } catch {
        notes.push("verification resolved_drift write skipped (non-fatal)");
      }
    } else {
      try {
        await supabase.from("canonical_invalidation_events").insert({
          canonical_plan_id: canonicalPlanId,
          document_type: docType,
          event_type: "verification_mode_resolved_noise",
          baseline_value_jsonb: baselineToTuple(baseline),
          divergent_value_jsonb: parse,
        });
        notes.push("VERIFICATION RESOLVED → NOISE (challenger not reconfirmed) → baseline intact");
      } catch {
        notes.push("verification resolved_noise write skipped (non-fatal)");
      }
    }
    return { mode: "resolve", outcome: decision, notes };
  }

  // ── OPEN candidate ───────────────────────────────────────────────────────────
  // Suppressed while re-baselining (the canonical is already rebuilding).
  if (!inReBaselineMode && forcedReparseReason && NON_VERIFICATION_FORCED.has(forcedReparseReason)) {
    if (!tupleDivergesFromBaseline(parse, baseline)) {
      return { mode: "open", outcome: "no_divergence", notes };
    }
    if (!divergingFieldsPlausible(parse, baseline)) {
      notes.push("forced re-parse diverged IMPLAUSIBLY (treated as noise — verification NOT opened)");
      return { mode: "open", outcome: "implausible", notes };
    }
    try {
      await supabase
        .from("canonical_plans")
        .update({ divergence_pending_verification: true })
        .eq("id", canonicalPlanId);
      await supabase.from("canonical_invalidation_events").insert({
        canonical_plan_id: canonicalPlanId,
        document_type: docType,
        event_type: "verification_mode_triggered",
        baseline_value_jsonb: baselineToTuple(baseline),
        divergent_value_jsonb: parse, // the challenger — read back on resolve
      });
      notes.push(
        `VERIFICATION OPENED — forced ${forcedReparseReason} diverged plausibly; next upload (any doc-type) forced to verify`,
      );
    } catch {
      notes.push("verification open write skipped (non-fatal)");
    }
    return { mode: "open", outcome: "opened", notes };
  }

  return { mode: "none", outcome: forcedReparseReason ? "forced_no_action" : "not_forced", notes };
}
