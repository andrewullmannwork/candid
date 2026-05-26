/**
 * Phase 4.0.5 Task 4.0.5-E — Targeted re-parse server library.
 *
 * Re-dispatches Haiku on un-searched SBC sections for a single plan-identity
 * field (insurance_plans column) OR per-service field (plan_covered_services
 * column). Writes back to the user's own row only — Pattern 1 #14 + Engineering
 * North Star #1 ([[Candid_Data_Principles]] §1 + §2).
 *
 * Cost discipline (Q-P4.0.5-3 LOCK; DR §2):
 *   - Per re-parse: $0.10 USD hard cap (admin-tunable via
 *     `consumer_read_filter_v1.config.reparse_cost_cap_usd`)
 *   - Per plan per day: $0.50 USD hard cap (5 re-parses typical), tunable via
 *     `consumer_read_filter_v1.config.reparse_daily_cap_per_plan_usd`
 *   - Rate limit: 1 re-parse per minute per plan (in-memory check via
 *     parse_audit_runs latest row created_at)
 *   - Pre-dispatch projection aborts when projected cost exceeds cap
 *
 * Prompt strategy (Q-P4.0.5-4 LOCK; DR §1): re-uses existing per-section Haiku
 * prompts unchanged. Output is full section data; we project to the requested
 * field on receipt. Engineering North Star #1 — same prompts as first-parse,
 * zero drift risk.
 *
 * Pattern P-8 verifier orchestration: each Haiku output's patternP8 runs
 * through shared `verifyOne()` (whitespace + Unicode normalization fallback);
 * verbatim_absent derivation fires when union of searched_sections covers ALL
 * non-DO_NOT_EXTRACT SBC sections (Q-P4.0.5-2 LOCK).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { segmentSBCSections, sliceSection } from "../sbc/section-segment";
import type {
  SBCHaikuParseResult,
  SBCHaikuService,
  SBCPatternP8Provenance,
  SBCPlanField,
  SBCPlanIdentity,
  SBCSectionHint,
  SBCSectionResult,
} from "../sbc/types";
import { extractImportantQuestions } from "../sbc/haiku-prompts/important-questions";
import { extractCommonMedicalEvents } from "../sbc/haiku-prompts/common-medical-events";
import { extractOtherCovered } from "../sbc/haiku-prompts/other-covered";
import { extractExcludedServices } from "../sbc/haiku-prompts/excluded-services";
import { extractAppealsGrievances } from "../sbc/haiku-prompts/appeals-grievances";
import { verifyOne, type VerifyContext } from "../parser/verify-source-excerpts";
import type { FieldProvenanceEntry } from "../parser/field-categories";
import { decorateFieldFromEntry, type DecoratedValue } from "../parser/consumer-read";
import { readFeatureFlagConfig } from "../config/product-flags";
import type { DecorationContext } from "./analyze-decoration";
import { recordCostEvent } from "@/lib/cost/parse-cost-events";

/** All SBC sections that are eligible for re-dispatch — DO_NOT_EXTRACT excluded. */
const NON_DO_NOT_EXTRACT_SBC_SECTIONS: SBCSectionHint[] = [
  "important_questions",
  "common_medical_events",
  "other_covered_services",
  "excluded_services",
  "appeals_grievances",
];

/** Plan-identity columns (insurance_plans) → SBCPlanIdentity field-key. */
const INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD: Record<string, keyof SBCPlanIdentity> = {
  plan_name: "planName",
  insurer_name: "insurerName",
  plan_type: "planType",
  plan_year: "planYear",
  in_deductible_individual: "deductibleIndividual",
  in_deductible_family: "deductibleFamily",
  in_oop_max_individual: "oopMaxIndividual",
  in_oop_max_family: "oopMaxFamily",
};

/** plan_covered_services column → SBCHaikuService field on which patternP8 lives.
 *  All cost-sharing fields share ONE patternP8 per service (Q-P3.2.1-5 — single
 *  row excerpt covers all cost-sharing fields). So projection picks the service
 *  by slug + reads `service.patternP8` regardless of which column is requested. */
const PLAN_COVERED_SERVICES_REPARSE_COLUMNS = new Set([
  "in_copay",
  "in_coinsurance",
  "in_deductible_applies",
  "in_cost_description",
  "in_copay_waiver_condition",
  "out_copay",
  "out_coinsurance",
  "out_deductible_applies",
  "out_cost_description",
  "annual_limit",
  "annual_limit_value",
  "prior_auth_required",
  "covered",
  "coverage_conditions",
  "supply_limit_days",
  "home_delivery_copay",
  "step_therapy_required",
]);

/** Haiku 4.5 pricing — published Anthropic rates. Per-token. */
const HAIKU_INPUT_PRICE_PER_TOKEN = 0.8 / 1_000_000;
const HAIKU_OUTPUT_PRICE_PER_TOKEN = 4.0 / 1_000_000;
const ESTIMATED_OUTPUT_TOKENS = 200;

/** Default cost caps (admin-tunable via consumer_read_filter_v1.config). */
const DEFAULT_REPARSE_COST_CAP_USD = 0.1;
const DEFAULT_REPARSE_DAILY_CAP_USD = 0.5;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute per plan

export type ReparseError =
  | "ocr_text_not_cached"
  | "no_unsearched_sections"
  | "cost_cap_exceeded"
  | "daily_cap_exceeded"
  | "rate_limit_exceeded"
  | "field_not_eligible"
  | "plan_not_found"
  | "service_not_found"
  | "internal_error";

export interface ReparseFieldRequest {
  planId: string;
  fieldName: string;
  /** When provided, target plan_covered_services row by service_catalog.slug. Otherwise insurance_plans. */
  serviceSlug?: string;
}

export interface ReparseFieldResult {
  success: boolean;
  decoratedValue?: DecoratedValue<unknown>;
  /** Final source_excerpt_verified state after merge (verified | not_found | verbatim_absent | ocr_unverifiable). */
  finalVerifiedState?: string;
  error?: ReparseError;
  /** Actual Haiku spend on this re-parse (0 when error returned pre-dispatch). */
  costUsd?: number;
  /** Sections newly dispatched in this re-parse. */
  dispatchedThisRun?: SBCSectionHint[];
}

/**
 * Re-dispatch Haiku on un-searched SBC sections for `request.fieldName`.
 *
 * Caller responsibility:
 *   - Authentication (validate userId via firebase admin token)
 *   - Authorization (verify plan ownership; supabase RLS + planId.user_id check)
 *   - Feature-flag gate (`consumer_read_filter_v1` + admin-only soak per Q-P4-7)
 *   - Decoration context loaded for response shape (multiSourceThreshold)
 *
 * This function handles:
 *   - OCR text + field_provenance retrieval
 *   - Cost cap projection (per re-parse + per plan per day) + rate limit
 *   - Per-section dispatch via existing per-section Haiku prompts (Q-P4.0.5-4)
 *   - Pattern P-8 verification + verbatim_absent derivation when union covers ALL
 *   - JSONB shallow-merge into existing field_provenance + UPDATE
 *   - parse_audit_runs row insertion for telemetry + daily-cap aggregation
 */
export async function reparseField(
  supabase: SupabaseClient,
  userId: string,
  request: ReparseFieldRequest,
  decorationContext: DecorationContext,
): Promise<ReparseFieldResult> {
  // ── Step 1: Verify field eligibility ────────────────────────────────────
  const isPlanIdentity = !request.serviceSlug;
  if (isPlanIdentity) {
    if (!(request.fieldName in INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD)) {
      return { success: false, error: "field_not_eligible" };
    }
  } else {
    if (!PLAN_COVERED_SERVICES_REPARSE_COLUMNS.has(request.fieldName)) {
      return { success: false, error: "field_not_eligible" };
    }
  }

  // ── Step 2: Load plan + verify ownership ─────────────────────────────────
  const { data: plan, error: planErr } = await supabase
    .from("insurance_plans")
    .select("id, user_id, source_document_id, field_provenance, canonical_plan_id")
    .eq("id", request.planId)
    .single();
  if (planErr || !plan) return { success: false, error: "plan_not_found" };
  if (plan.user_id !== userId) return { success: false, error: "plan_not_found" };
  if (!plan.source_document_id) return { success: false, error: "ocr_text_not_cached" };

  // ── Step 3: Load OCR text from source document ────────────────────────────
  const { data: doc } = await supabase
    .from("documents")
    .select("processing_ocr_text")
    .eq("id", plan.source_document_id)
    .single();
  if (!doc?.processing_ocr_text) return { success: false, error: "ocr_text_not_cached" };
  const ocrText: string = doc.processing_ocr_text;

  // ── Step 4: Resolve target row + current FieldProvenanceEntry ────────────
  let currentEntry: FieldProvenanceEntry | null = null;
  let serviceRowId: string | null = null;
  let currentValue: unknown = null;

  if (isPlanIdentity) {
    currentEntry =
      ((plan.field_provenance as Record<string, FieldProvenanceEntry> | null)?.[request.fieldName]) ?? null;
    // Fetch the actual column value for decoration return.
    const { data: planFull } = await supabase
      .from("insurance_plans")
      .select(request.fieldName)
      .eq("id", request.planId)
      .single();
    currentValue = (planFull as Record<string, unknown> | null)?.[request.fieldName] ?? null;
  } else {
    const { data: pcs, error: pcsErr } = await supabase
      .from("plan_covered_services")
      .select("id, field_provenance, service_catalog!inner(slug)")
      .eq("insurance_plan_id", request.planId)
      .eq("service_catalog.slug", request.serviceSlug as string)
      .maybeSingle();
    if (pcsErr || !pcs) return { success: false, error: "service_not_found" };
    serviceRowId = pcs.id as string;
    currentEntry =
      ((pcs.field_provenance as Record<string, FieldProvenanceEntry> | null)?.[request.fieldName]) ?? null;
    currentValue = (pcs as unknown as Record<string, unknown>)[request.fieldName] ?? null;
  }

  if (!currentEntry?.searched_sections || currentEntry.searched_sections.length === 0) {
    // Forward-only per Q-P4.0.5-7 LOCK: pre-Phase-4.0.5 rows have undefined
    // searched_sections; UI falls back to single-link affordance.
    return { success: false, error: "ocr_text_not_cached" };
  }

  // ── Step 5: Determine un-searched sections ────────────────────────────────
  const searchedSet = new Set(currentEntry.searched_sections);
  const unsearched = NON_DO_NOT_EXTRACT_SBC_SECTIONS.filter((s) => !searchedSet.has(s));
  if (unsearched.length === 0) {
    return { success: false, error: "no_unsearched_sections" };
  }

  // ── Step 6: Re-segment OCR text + project cost ────────────────────────────
  const sectionRanges: SectionRanges = segmentSBCSections(ocrText);
  const reparseCostCapUsd = await readFeatureFlagConfig(
    "consumer_read_filter_v1",
    "reparse_cost_cap_usd",
    DEFAULT_REPARSE_COST_CAP_USD,
  );
  const dailyCapUsd = await readFeatureFlagConfig(
    "consumer_read_filter_v1",
    "reparse_daily_cap_per_plan_usd",
    DEFAULT_REPARSE_DAILY_CAP_USD,
  );

  let projectedCost = 0;
  for (const section of unsearched) {
    const range = sectionRanges[section]?.[0];
    if (!range) continue;
    const sectionText = ocrText.slice(range.start, range.end);
    const tokenEstimate = sectionText.length / 4;
    projectedCost +=
      tokenEstimate * HAIKU_INPUT_PRICE_PER_TOKEN +
      ESTIMATED_OUTPUT_TOKENS * HAIKU_OUTPUT_PRICE_PER_TOKEN;
  }
  if (projectedCost > reparseCostCapUsd) {
    return { success: false, error: "cost_cap_exceeded" };
  }

  // ── Step 7: Daily-cap check + rate-limit (parse_audit_runs aggregation) ──
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: priorRuns } = await supabase
    .from("parse_audit_runs")
    .select("cost_usd, created_at")
    .eq("parser_name", "reparse_field")
    .eq("fixture_id", `plan:${request.planId}`)
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false });
  const dailyUsed = (priorRuns ?? []).reduce(
    (sum: number, r: { cost_usd: number | null }) => sum + (r.cost_usd ?? 0),
    0,
  );
  if (dailyUsed + projectedCost > dailyCapUsd) {
    return { success: false, error: "daily_cap_exceeded" };
  }
  // Rate-limit: 1 per minute per plan (latest row's created_at)
  const latestRunCreatedAt = (priorRuns ?? [])[0]?.created_at;
  if (latestRunCreatedAt) {
    const sinceMs = Date.now() - new Date(latestRunCreatedAt).getTime();
    if (sinceMs < RATE_LIMIT_WINDOW_MS) {
      return { success: false, error: "rate_limit_exceeded" };
    }
  }

  // ── Step 8: Dispatch Haiku per un-searched section ────────────────────────
  const ctx: VerifyContext = { normalizedRawDocText: null };
  const extractionMethod: ExtractionMethod = "pdftotext"; // SBC pipeline default
  let actualCost = 0;
  const dispatchedThisRun: SBCSectionHint[] = [];

  // Best-of mode: keep the highest-quality patternP8 found across all dispatched
  // sections. "verified" beats "not_found"; first verified wins.
  let bestPatternP8: SBCPatternP8Provenance | null = null;

  for (const section of unsearched) {
    const range = sectionRanges[section]?.[0];
    if (!range) {
      // Section not detected in OCR — record as searched (we tried) but no result.
      dispatchedThisRun.push(section);
      continue;
    }
    const sectionText = sliceSection(ocrText, sectionRanges, section);
    if (!sectionText) {
      dispatchedThisRun.push(section);
      continue;
    }

    let patternP8: SBCPatternP8Provenance | undefined;
    let sectionCost = 0;

    try {
      if (section === "important_questions") {
        const result = await extractImportantQuestions(sectionText, range, extractionMethod);
        sectionCost = result.haiku_cost_usd;
        patternP8 = projectFromImportantQuestions(result, request.fieldName);
      } else if (section === "common_medical_events" || section === "other_covered_services") {
        const result =
          section === "common_medical_events"
            ? await extractCommonMedicalEvents(sectionText, range, extractionMethod)
            : await extractOtherCovered(sectionText, range, extractionMethod);
        sectionCost = result.haiku_cost_usd;
        if (request.serviceSlug) {
          patternP8 = projectFromServiceList(result, request.serviceSlug);
        }
        // Plan-identity fields don't appear in common_medical_events / other_covered_services
        // — projection returns undefined; section still recorded as searched.
      } else if (section === "excluded_services") {
        const result = await extractExcludedServices(sectionText, range, extractionMethod);
        sectionCost = result.haiku_cost_usd;
        // No projectable target field in excluded_services for v1; section recorded.
      } else if (section === "appeals_grievances") {
        const result = await extractAppealsGrievances(sectionText, range, extractionMethod);
        sectionCost = result.haiku_cost_usd;
        // No projectable target field in appeals_grievances for v1; section recorded.
      }
    } catch (err) {
      console.error(`[reparse-field] Section ${section} dispatch failed:`, err);
      // Section dispatch failed — do NOT record as searched (so user can retry).
      continue;
    }

    actualCost += sectionCost;
    dispatchedThisRun.push(section);

    if (patternP8) {
      verifyOne(patternP8, ocrText, sectionRanges, `reparse:${section}:${request.fieldName}`, ctx);
      if (
        patternP8.source_excerpt_verified === "verified" &&
        patternP8.source_section_verified
      ) {
        bestPatternP8 = patternP8;
        break; // First verified excerpt wins; stop dispatching to save cost
      }
      if (!bestPatternP8 && patternP8.source_excerpt) {
        bestPatternP8 = patternP8;
      }
    }
  }

  // ── Step 9: Merge into existing field_provenance ──────────────────────────
  const newSearchedSections = Array.from(
    new Set([...currentEntry.searched_sections, ...dispatchedThisRun]),
  );
  const allCovered = NON_DO_NOT_EXTRACT_SBC_SECTIONS.every((s) =>
    newSearchedSections.includes(s),
  );

  const updatedEntry: FieldProvenanceEntry = {
    ...currentEntry,
    searched_sections: newSearchedSections,
    last_corroborated_at: new Date().toISOString(),
  };

  if (bestPatternP8 && bestPatternP8.source_excerpt_verified === "verified") {
    // Replace excerpt with newly-verified one.
    updatedEntry.source_excerpt = bestPatternP8.source_excerpt;
    updatedEntry.source_excerpt_verified = "verified";
    updatedEntry.source_excerpt_extraction_method = bestPatternP8.source_excerpt_extraction_method;
    updatedEntry.source_section_hint = bestPatternP8.source_section_hint;
    updatedEntry.source_section_verified = bestPatternP8.source_section_verified;
  } else if (currentEntry.source_excerpt_verified === "not_found" && allCovered) {
    // verbatim_absent derivation per Q-P4.0.5-2 LOCK.
    updatedEntry.source_excerpt_verified = "verbatim_absent";
  }

  // ── Step 10: Write back via JSONB shallow-merge UPDATE ───────────────────
  if (isPlanIdentity) {
    const newFieldProvenance = {
      ...((plan.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {}),
      [request.fieldName]: updatedEntry,
    };
    const { error: updErr } = await supabase
      .from("insurance_plans")
      .update({ field_provenance: newFieldProvenance })
      .eq("id", request.planId);
    if (updErr) {
      console.error("[reparse-field] insurance_plans UPDATE failed:", updErr);
      return { success: false, error: "internal_error" };
    }
  } else {
    const { data: pcsRow } = await supabase
      .from("plan_covered_services")
      .select("field_provenance")
      .eq("id", serviceRowId as string)
      .single();
    const newFieldProvenance = {
      ...((pcsRow?.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {}),
      [request.fieldName]: updatedEntry,
    };
    const { error: updErr } = await supabase
      .from("plan_covered_services")
      .update({ field_provenance: newFieldProvenance })
      .eq("id", serviceRowId as string);
    if (updErr) {
      console.error("[reparse-field] plan_covered_services UPDATE failed:", updErr);
      return { success: false, error: "internal_error" };
    }
  }

  // ── Step 11: Audit run row for daily-cap + admin observability ────────────
  await supabase.from("parse_audit_runs").insert({
    run_id: `reparse_${request.planId}_${Date.now()}`,
    parser_version: "phase_4.0.5",
    parser_name: "reparse_field",
    fixture_id: `plan:${request.planId}`,
    fixture_kind: "reparse_event",
    cost_usd: actualCost,
    parse_status: "success",
    per_field_results: {
      field: request.fieldName,
      service_slug: request.serviceSlug ?? null,
      sections_dispatched: dispatchedThisRun,
      final_verified_state: updatedEntry.source_excerpt_verified ?? "not_found",
    },
  });

  // ── Step 11b: parse_cost_events ledger (Cost-F, S129) ────────────────────
  // Parallel write to unified cost ledger. user_upload cost_source = this
  // path is user-triggered (admin/UI button). Auto-reparse path goes
  // through reparse-fields-batch.ts (different cost_source).
  await recordCostEvent(supabase, {
    canonicalPlanId: (plan.canonical_plan_id as string | null | undefined) ?? null,
    insurancePlanId: request.planId,
    documentId: plan.source_document_id as string,
    userId,
    parserKind: "reparse_field",
    costSource: "user_upload",
    costUsd: actualCost,
    metadata: {
      field_name: request.fieldName,
      service_slug: request.serviceSlug ?? null,
      sections_dispatched: dispatchedThisRun,
    },
  });

  // ── Step 12: Decorate updated value for client ────────────────────────────
  const sourceLabel = isPlanIdentity ? "doc_extraction" : "doc_extraction";
  const decorated = decorateFieldFromEntry(currentValue, updatedEntry, {
    sourceCount: 1, // self-source post-re-parse
    source: sourceLabel,
    multiSourceThreshold: decorationContext.multiSourceThreshold,
  });

  return {
    success: true,
    decoratedValue: decorated,
    finalVerifiedState: updatedEntry.source_excerpt_verified ?? "not_found",
    costUsd: actualCost,
    dispatchedThisRun,
  };
}

// ── Internal helpers — projection from full section result → single field ──

function projectFromImportantQuestions(
  result: SBCSectionResult<SBCPlanIdentity>,
  fieldName: string,
): SBCPatternP8Provenance | undefined {
  const planFieldKey = INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD[fieldName];
  if (!planFieldKey) return undefined;
  // Type-erased access — SBCPlanIdentity values are SBCPlanField<T> for varying T.
  const planField = (result.data as unknown as Record<string, SBCPlanField<unknown>>)[planFieldKey];
  if (!planField || !planField.patternP8) return undefined;
  // Deep clone so mutations from verifyOne don't pollute caller state.
  return JSON.parse(JSON.stringify(planField.patternP8)) as SBCPatternP8Provenance;
}

function projectFromServiceList(
  result: SBCSectionResult<{ services: SBCHaikuService[] }>,
  serviceSlug: string,
): SBCPatternP8Provenance | undefined {
  const service = result.data.services.find((s) => s.serviceSlug === serviceSlug);
  if (!service?.patternP8) return undefined;
  return JSON.parse(JSON.stringify(service.patternP8)) as SBCPatternP8Provenance;
}

// Re-export for tests / callers needing the section enum.
export { NON_DO_NOT_EXTRACT_SBC_SECTIONS };
// Helpers for smoke test C10 verbatim_absent boundary cases.
export function deriveVerbatimAbsentFromCoverage(
  currentVerified: string,
  searchedSections: string[],
): string {
  if (currentVerified !== "not_found") return currentVerified;
  const allCovered = NON_DO_NOT_EXTRACT_SBC_SECTIONS.every((s) => searchedSections.includes(s));
  return allCovered ? "verbatim_absent" : "not_found";
}
// Phase 4.0.5 type re-export for SBCHaikuParseResult-aware callers.
export type { SBCHaikuParseResult };
