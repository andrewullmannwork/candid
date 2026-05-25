/**
 * Ing-A (S127) — Batched targeted re-parse for auto-reparse triage path.
 *
 * Peer of `reparseField` (Phase 4.0.5 Task 4.0.5-E user-triggered single-field
 * path) that accepts a LIST of (fieldName, serviceSlug?) requests for a single
 * plan + dispatches each un-searched section ONCE, projecting ALL requested
 * fields per section result. This collapses N-field upload reparses from N
 * Haiku calls per section into ONE call per section — same OCR, same prompt,
 * same verifier, smarter projection. ~5× cost reduction on multi-field uploads
 * at expected scale (S126 cost-optimization lock).
 *
 * INVARIANTS preserved from `reparseField` (no quality drift):
 *   - Same per-section Haiku prompts (no prompt forks)
 *   - Same Pattern P-8 verifier (`verifyOne()` against OCR text)
 *   - Same field-eligibility allow-list (INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD
 *     + PLAN_COVERED_SERVICES_REPARSE_COLUMNS)
 *   - Same field_provenance JSONB shallow-merge UPDATE semantics
 *   - Same verbatim_absent derivation rule (union-covers-all + currently
 *     not_found)
 *   - Same cost caps (`consumer_read_filter_v1.config.reparse_cost_cap_usd` +
 *     `reparse_daily_cap_per_plan_usd`)
 *
 * NEW semantics vs `reparseField`:
 *   - Cap applies to TOTAL projected cost across the union of un-searched
 *     sections (not per-field) — per S126 "tighter $0.10-per-upload ceiling".
 *   - Daily-cap aggregation reads parse_audit_runs rows where
 *     parser_name IN ('reparse_field', 'reparse_field_batch') so the daily
 *     ceiling is shared across user-triggered + auto-triggered paths.
 *   - Rate-limit preserved (1/minute per plan); auto-reparse triage caller
 *     normally won't hit it (one batch per upload), but kept as a safety net.
 *   - Single parse_audit_runs row per batch with parser_name='reparse_field_batch'
 *     + per_field_results = array of { field, service_slug, outcome,
 *     final_verified_state }.
 *   - Cost attribution per field = total Haiku cost / fields requested (even
 *     attribution; the per-field telemetry table stores this for
 *     /admin/auto-reparse-stats roll-ups).
 *
 * Caller responsibility (same as `reparseField`):
 *   - Authentication (firebase admin token validation) — for system-triggered
 *     auto-reparse via triage hook, authentication is implicit (the actor
 *     who uploaded the document has already been authenticated upstream).
 *   - Authorization (plan ownership) — auto-reparse triage operates on the
 *     actor's own insurance_plans row resolved by canonical_plan_id linkage
 *     (Pattern 1 #14 user-scoped writes).
 *   - Feature-flag gate (`auto_reparse_enabled` for the triage path; existing
 *     `consumer_read_filter_v1` config flag still governs cost caps).
 *   - Decoration context loaded for response shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractionMethod, SectionRanges } from "../parser/types";
import { segmentSBCSections, sliceSection } from "../sbc/section-segment";
import type {
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

/** All SBC sections eligible for re-dispatch — DO_NOT_EXTRACT excluded. */
const NON_DO_NOT_EXTRACT_SBC_SECTIONS: SBCSectionHint[] = [
  "important_questions",
  "common_medical_events",
  "other_covered_services",
  "excluded_services",
  "appeals_grievances",
];

/** Plan-identity columns (insurance_plans) → SBCPlanIdentity field-key.
 *  Kept identical to `reparseField` allow-list (Engineering North Star #1). */
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

/** plan_covered_services columns eligible for re-parse. Identical to single
 *  path's allow-list — auto-triage uses the same field surface. */
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

const HAIKU_INPUT_PRICE_PER_TOKEN = 0.8 / 1_000_000;
const HAIKU_OUTPUT_PRICE_PER_TOKEN = 4.0 / 1_000_000;
const ESTIMATED_OUTPUT_TOKENS = 200;

const DEFAULT_REPARSE_COST_CAP_USD = 0.1;
const DEFAULT_REPARSE_DAILY_CAP_USD = 0.5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export type BatchReparseError =
  | "ocr_text_not_cached"
  | "no_unsearched_sections"
  | "cost_cap_exceeded"
  | "daily_cap_exceeded"
  | "rate_limit_exceeded"
  | "plan_not_found"
  | "no_eligible_fields"
  | "internal_error";

export type PerFieldOutcome =
  | "reparse_changed_value"
  | "reparse_confirmed_null"
  | "reparse_no_change"
  | "reparse_skipped_no_sections"
  | "reparse_failed";

export interface BatchFieldRequest {
  fieldName: string;
  /** When provided, target plan_covered_services row by service_catalog.slug.
   *  Otherwise targets insurance_plans column. */
  serviceSlug?: string;
}

export interface BatchPerFieldResult {
  fieldName: string;
  serviceSlug: string | null;
  outcome: PerFieldOutcome;
  finalVerifiedState?: string;
  decoratedValue?: DecoratedValue<unknown>;
  costAttributedUsd?: number;
}

export interface ReparseFieldsBatchResult {
  /** Top-level outcome — when batch was rejected before any dispatch. */
  batchError?: BatchReparseError;
  perField: BatchPerFieldResult[];
  totalCostUsd: number;
  dispatchedSections: SBCSectionHint[];
}

/**
 * Re-dispatch Haiku on the union of un-searched sections across all requests,
 * projecting EACH request's field from the appropriate section result.
 *
 * Single OCR load + segmentation + cost-cap check + Haiku dispatch loop per
 * call. Per-field UPDATEs serialize after dispatch.
 */
export async function reparseFieldsBatch(
  supabase: SupabaseClient,
  userId: string,
  planId: string,
  requests: BatchFieldRequest[],
  decorationContext: DecorationContext,
): Promise<ReparseFieldsBatchResult> {
  // ── Step 0: Filter to eligible requests (allow-list gate) ────────────────
  const eligible = requests.filter((r) => {
    if (r.serviceSlug) return PLAN_COVERED_SERVICES_REPARSE_COLUMNS.has(r.fieldName);
    return r.fieldName in INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD;
  });
  if (eligible.length === 0) {
    return {
      batchError: "no_eligible_fields",
      perField: [],
      totalCostUsd: 0,
      dispatchedSections: [],
    };
  }

  // ── Step 1: Load plan + verify ownership ────────────────────────────────
  const { data: plan, error: planErr } = await supabase
    .from("insurance_plans")
    .select("id, user_id, source_document_id, field_provenance")
    .eq("id", planId)
    .single();
  if (planErr || !plan) {
    return { batchError: "plan_not_found", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }
  if (plan.user_id !== userId) {
    return { batchError: "plan_not_found", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }
  if (!plan.source_document_id) {
    return { batchError: "ocr_text_not_cached", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }

  // ── Step 2: Load OCR text ────────────────────────────────────────────────
  const { data: doc } = await supabase
    .from("documents")
    .select("processing_ocr_text")
    .eq("id", plan.source_document_id)
    .single();
  if (!doc?.processing_ocr_text) {
    return { batchError: "ocr_text_not_cached", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }
  const ocrText: string = doc.processing_ocr_text;

  // ── Step 3: Resolve per-request current entries + un-searched union ──────
  interface RequestContext {
    request: BatchFieldRequest;
    currentEntry: FieldProvenanceEntry;
    currentValue: unknown;
    /** plan_covered_services.id when service-scoped; null when plan-identity. */
    serviceRowId: string | null;
  }

  const contexts: RequestContext[] = [];
  const planIdentityFp = (plan.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {};

  // Cache plan_covered_services lookups by service slug to avoid duplicate queries.
  const slugToPcsRow = new Map<
    string,
    { id: string; field_provenance: Record<string, FieldProvenanceEntry> | null; columns: Record<string, unknown> }
  >();

  // Fetch insurance_plans full row once for plan-identity column reads.
  let planRowFull: Record<string, unknown> | null = null;
  const planIdentityFields = eligible.filter((r) => !r.serviceSlug).map((r) => r.fieldName);
  if (planIdentityFields.length > 0) {
    const cols = ["id", ...new Set(planIdentityFields)].join(",");
    const { data: planFull } = await supabase
      .from("insurance_plans")
      .select(cols)
      .eq("id", planId)
      .single();
    planRowFull = (planFull as Record<string, unknown> | null) ?? null;
  }

  // Resolve each request's context.
  for (const req of eligible) {
    if (!req.serviceSlug) {
      const entry = planIdentityFp[req.fieldName] ?? null;
      if (!entry?.searched_sections || entry.searched_sections.length === 0) {
        // Forward-only: pre-Phase-4.0.5 rows have no searched_sections; skip.
        continue;
      }
      contexts.push({
        request: req,
        currentEntry: entry,
        currentValue: planRowFull?.[req.fieldName] ?? null,
        serviceRowId: null,
      });
    } else {
      let pcs = slugToPcsRow.get(req.serviceSlug);
      if (!pcs) {
        const { data: pcsRow } = await supabase
          .from("plan_covered_services")
          .select(
            "id, field_provenance, in_copay, in_coinsurance, in_deductible_applies, in_cost_description, in_copay_waiver_condition, out_copay, out_coinsurance, out_deductible_applies, out_cost_description, annual_limit, annual_limit_value, prior_auth_required, covered, coverage_conditions, supply_limit_days, home_delivery_copay, step_therapy_required, service_catalog!inner(slug)",
          )
          .eq("insurance_plan_id", planId)
          .eq("service_catalog.slug", req.serviceSlug)
          .maybeSingle();
        if (!pcsRow) continue;
        const { service_catalog: _sc, id, field_provenance, ...rest } = pcsRow as Record<string, unknown> & { id: string; field_provenance: unknown };
        void _sc;
        pcs = {
          id,
          field_provenance: (field_provenance as Record<string, FieldProvenanceEntry> | null) ?? null,
          columns: rest,
        };
        slugToPcsRow.set(req.serviceSlug, pcs);
      }
      const entry = pcs.field_provenance?.[req.fieldName] ?? null;
      if (!entry?.searched_sections || entry.searched_sections.length === 0) continue;
      contexts.push({
        request: req,
        currentEntry: entry,
        currentValue: pcs.columns[req.fieldName] ?? null,
        serviceRowId: pcs.id,
      });
    }
  }

  if (contexts.length === 0) {
    return {
      batchError: "no_unsearched_sections",
      perField: [],
      totalCostUsd: 0,
      dispatchedSections: [],
    };
  }

  // ── Step 4: Union of un-searched sections across all contexts ────────────
  const unionUnsearched = new Set<SBCSectionHint>();
  for (const ctx of contexts) {
    const searched = new Set(ctx.currentEntry.searched_sections ?? []);
    for (const s of NON_DO_NOT_EXTRACT_SBC_SECTIONS) {
      if (!searched.has(s)) unionUnsearched.add(s);
    }
  }
  if (unionUnsearched.size === 0) {
    return {
      batchError: "no_unsearched_sections",
      perField: [],
      totalCostUsd: 0,
      dispatchedSections: [],
    };
  }
  const unsearchedList = NON_DO_NOT_EXTRACT_SBC_SECTIONS.filter((s) => unionUnsearched.has(s));

  // ── Step 5: Cost projection over union + cap checks ──────────────────────
  const sectionRanges: SectionRanges = segmentSBCSections(ocrText);
  const perBatchCapUsd = await readFeatureFlagConfig(
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
  for (const section of unsearchedList) {
    const range = sectionRanges[section]?.[0];
    if (!range) continue;
    const sectionText = ocrText.slice(range.start, range.end);
    const tokenEstimate = sectionText.length / 4;
    projectedCost +=
      tokenEstimate * HAIKU_INPUT_PRICE_PER_TOKEN +
      ESTIMATED_OUTPUT_TOKENS * HAIKU_OUTPUT_PRICE_PER_TOKEN;
  }
  if (projectedCost > perBatchCapUsd) {
    return { batchError: "cost_cap_exceeded", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }

  // Daily-cap + rate-limit aggregated across user-triggered + auto-triggered.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: priorRuns } = await supabase
    .from("parse_audit_runs")
    .select("cost_usd, created_at")
    .in("parser_name", ["reparse_field", "reparse_field_batch"])
    .eq("fixture_id", `plan:${planId}`)
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false });
  const dailyUsed = (priorRuns ?? []).reduce(
    (sum: number, r: { cost_usd: number | null }) => sum + (r.cost_usd ?? 0),
    0,
  );
  if (dailyUsed + projectedCost > dailyCapUsd) {
    return { batchError: "daily_cap_exceeded", perField: [], totalCostUsd: 0, dispatchedSections: [] };
  }
  const latestRunCreatedAt = (priorRuns ?? [])[0]?.created_at;
  if (latestRunCreatedAt) {
    const sinceMs = Date.now() - new Date(latestRunCreatedAt).getTime();
    if (sinceMs < RATE_LIMIT_WINDOW_MS) {
      return { batchError: "rate_limit_exceeded", perField: [], totalCostUsd: 0, dispatchedSections: [] };
    }
  }

  // ── Step 6: Dispatch Haiku per un-searched section + collect full results ──
  const verifyCtx: VerifyContext = { normalizedRawDocText: null };
  const extractionMethod: ExtractionMethod = "pdftotext";
  let actualCost = 0;
  const dispatchedThisRun: SBCSectionHint[] = [];

  // Per-section full results held in memory so we can project ALL requested
  // fields from each. Keys: section hint.
  type SectionResultBag =
    | { kind: "important_questions"; data: SBCSectionResult<SBCPlanIdentity> }
    | { kind: "common_medical_events"; data: SBCSectionResult<{ services: SBCHaikuService[] }> }
    | { kind: "other_covered_services"; data: SBCSectionResult<{ services: SBCHaikuService[] }> }
    | { kind: "excluded_services"; data: unknown }
    | { kind: "appeals_grievances"; data: unknown };
  const sectionResults = new Map<SBCSectionHint, SectionResultBag>();

  for (const section of unsearchedList) {
    const range = sectionRanges[section]?.[0];
    if (!range) {
      dispatchedThisRun.push(section);
      continue;
    }
    const sectionText = sliceSection(ocrText, sectionRanges, section);
    if (!sectionText) {
      dispatchedThisRun.push(section);
      continue;
    }
    try {
      if (section === "important_questions") {
        const r = await extractImportantQuestions(sectionText, range, extractionMethod);
        actualCost += r.haiku_cost_usd;
        sectionResults.set(section, { kind: "important_questions", data: r });
      } else if (section === "common_medical_events") {
        const r = await extractCommonMedicalEvents(sectionText, range, extractionMethod);
        actualCost += r.haiku_cost_usd;
        sectionResults.set(section, { kind: "common_medical_events", data: r });
      } else if (section === "other_covered_services") {
        const r = await extractOtherCovered(sectionText, range, extractionMethod);
        actualCost += r.haiku_cost_usd;
        sectionResults.set(section, { kind: "other_covered_services", data: r });
      } else if (section === "excluded_services") {
        const r = await extractExcludedServices(sectionText, range, extractionMethod);
        actualCost += r.haiku_cost_usd;
        sectionResults.set(section, { kind: "excluded_services", data: r });
      } else if (section === "appeals_grievances") {
        const r = await extractAppealsGrievances(sectionText, range, extractionMethod);
        actualCost += r.haiku_cost_usd;
        sectionResults.set(section, { kind: "appeals_grievances", data: r });
      }
      dispatchedThisRun.push(section);
    } catch (err) {
      console.error(`[reparse-fields-batch] Section ${section} dispatch failed:`, err);
      // Don't record as searched — caller can retry next upload.
    }
  }

  // ── Step 7: Per-field projection + verification + write-back ─────────────
  const perFieldResults: BatchPerFieldResult[] = [];
  const costPerField = contexts.length > 0 ? actualCost / contexts.length : 0;

  // Group merged-updates by target row id to coalesce UPDATEs.
  const planRowUpdates: Record<string, FieldProvenanceEntry> = {};
  const serviceRowUpdates = new Map<string, Record<string, FieldProvenanceEntry>>();

  for (const ctx of contexts) {
    const { request, currentEntry, currentValue, serviceRowId } = ctx;
    let bestPatternP8: SBCPatternP8Provenance | null = null;

    for (const section of dispatchedThisRun) {
      const bag = sectionResults.get(section);
      if (!bag) continue;

      let p8: SBCPatternP8Provenance | undefined;
      if (bag.kind === "important_questions" && !request.serviceSlug) {
        p8 = projectFromImportantQuestions(bag.data, request.fieldName);
      } else if (
        (bag.kind === "common_medical_events" || bag.kind === "other_covered_services") &&
        request.serviceSlug
      ) {
        p8 = projectFromServiceList(bag.data, request.serviceSlug);
      }
      // excluded_services + appeals_grievances have no projectable field surface
      // in v1; included in dispatch so the section is recorded as searched.

      if (p8) {
        const p8Cloned = JSON.parse(JSON.stringify(p8)) as SBCPatternP8Provenance;
        verifyOne(
          p8Cloned,
          ocrText,
          sectionRanges,
          `reparse-batch:${section}:${request.fieldName}`,
          verifyCtx,
        );
        if (
          p8Cloned.source_excerpt_verified === "verified" &&
          p8Cloned.source_section_verified
        ) {
          bestPatternP8 = p8Cloned;
          break;
        }
        if (!bestPatternP8 && p8Cloned.source_excerpt) {
          bestPatternP8 = p8Cloned;
        }
      }
    }

    // Merge searched_sections + derive final state.
    const newSearchedSections = Array.from(
      new Set([...(currentEntry.searched_sections ?? []), ...dispatchedThisRun]),
    );
    const allCovered = NON_DO_NOT_EXTRACT_SBC_SECTIONS.every((s) =>
      newSearchedSections.includes(s),
    );
    const updatedEntry: FieldProvenanceEntry = {
      ...currentEntry,
      searched_sections: newSearchedSections,
      last_corroborated_at: new Date().toISOString(),
    };

    let outcome: PerFieldOutcome = "reparse_no_change";
    if (bestPatternP8 && bestPatternP8.source_excerpt_verified === "verified") {
      updatedEntry.source_excerpt = bestPatternP8.source_excerpt;
      updatedEntry.source_excerpt_verified = "verified";
      updatedEntry.source_excerpt_extraction_method =
        bestPatternP8.source_excerpt_extraction_method;
      updatedEntry.source_section_hint = bestPatternP8.source_section_hint;
      updatedEntry.source_section_verified = bestPatternP8.source_section_verified;
      // "changed_value" semantic: we got a verified excerpt where previously
      // there wasn't one. Note: the underlying column value may not change
      // here (we update provenance, not the column itself — column update
      // would require a separate write path). Conservative wording:
      // changed_value = "we have a verified excerpt now where we didn't before".
      outcome = currentEntry.source_excerpt_verified !== "verified"
        ? "reparse_changed_value"
        : "reparse_no_change";
    } else if (currentEntry.source_excerpt_verified === "not_found" && allCovered) {
      updatedEntry.source_excerpt_verified = "verbatim_absent";
      outcome = "reparse_confirmed_null";
    }

    // Stage update in coalescing map.
    if (!serviceRowId) {
      planRowUpdates[request.fieldName] = updatedEntry;
    } else {
      let bucket = serviceRowUpdates.get(serviceRowId);
      if (!bucket) {
        bucket = {};
        serviceRowUpdates.set(serviceRowId, bucket);
      }
      bucket[request.fieldName] = updatedEntry;
    }

    perFieldResults.push({
      fieldName: request.fieldName,
      serviceSlug: request.serviceSlug ?? null,
      outcome,
      finalVerifiedState: updatedEntry.source_excerpt_verified ?? "not_found",
      decoratedValue: decorateFieldFromEntry(currentValue, updatedEntry, {
        sourceCount: 1,
        source: "doc_extraction",
        multiSourceThreshold: decorationContext.multiSourceThreshold,
      }),
      costAttributedUsd: costPerField,
    });
  }

  // ── Step 8: Coalesced JSONB shallow-merge UPDATEs ────────────────────────
  if (Object.keys(planRowUpdates).length > 0) {
    const merged = {
      ...((plan.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {}),
      ...planRowUpdates,
    };
    const { error: updErr } = await supabase
      .from("insurance_plans")
      .update({ field_provenance: merged })
      .eq("id", planId);
    if (updErr) {
      console.error("[reparse-fields-batch] insurance_plans UPDATE failed:", updErr);
      // Convert affected per-field results to failed.
      for (const result of perFieldResults) {
        if (!result.serviceSlug && planRowUpdates[result.fieldName]) {
          result.outcome = "reparse_failed";
        }
      }
    }
  }

  for (const [rowId, fpUpdates] of serviceRowUpdates) {
    const { data: pcsCurrent } = await supabase
      .from("plan_covered_services")
      .select("field_provenance")
      .eq("id", rowId)
      .single();
    const merged = {
      ...((pcsCurrent?.field_provenance as Record<string, FieldProvenanceEntry> | null) ?? {}),
      ...fpUpdates,
    };
    const { error: updErr } = await supabase
      .from("plan_covered_services")
      .update({ field_provenance: merged })
      .eq("id", rowId);
    if (updErr) {
      console.error(
        `[reparse-fields-batch] plan_covered_services UPDATE failed (row ${rowId}):`,
        updErr,
      );
      for (const result of perFieldResults) {
        if (result.serviceSlug && fpUpdates[result.fieldName]) {
          result.outcome = "reparse_failed";
        }
      }
    }
  }

  // ── Step 9: Single parse_audit_runs row for the batch ────────────────────
  await supabase.from("parse_audit_runs").insert({
    run_id: `reparse_batch_${planId}_${Date.now()}`,
    parser_version: "phase_4.0.5",
    parser_name: "reparse_field_batch",
    fixture_id: `plan:${planId}`,
    fixture_kind: "reparse_event",
    cost_usd: actualCost,
    parse_status: "success",
    per_field_results: {
      fields: perFieldResults.map((r) => ({
        field: r.fieldName,
        service_slug: r.serviceSlug,
        outcome: r.outcome,
        final_verified_state: r.finalVerifiedState ?? "not_found",
      })),
      sections_dispatched: dispatchedThisRun,
      fields_requested: requests.length,
      fields_eligible: eligible.length,
      fields_dispatched: contexts.length,
    },
  });

  return {
    perField: perFieldResults,
    totalCostUsd: actualCost,
    dispatchedSections: dispatchedThisRun,
  };
}

// ── Projection helpers — identical contract to reparseField counterparts ──

function projectFromImportantQuestions(
  result: SBCSectionResult<SBCPlanIdentity>,
  fieldName: string,
): SBCPatternP8Provenance | undefined {
  const planFieldKey = INSURANCE_PLANS_COLUMN_TO_PLAN_FIELD[fieldName];
  if (!planFieldKey) return undefined;
  const planField = (result.data as unknown as Record<string, SBCPlanField<unknown>>)[planFieldKey];
  if (!planField || !planField.patternP8) return undefined;
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
