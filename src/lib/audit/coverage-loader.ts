/**
 * Plan-coverage lookup helper for the audit pipeline.
 *
 * Loads `plan_covered_services` for a given insurance plan and builds a
 * Map<service_slug, PlanCoverageInput> that rules consume to compute should_owe
 * (copay / coinsurance / deductible). Used by:
 *   • process-chunk first-audit (persist.ts caller)
 *   • reaudit.ts view-fetch re-audit (D7)
 *   • admin resolve-type re-classify path
 *   • disputes rerun-audit path
 *
 * Returns null when no plan id is provided (rules see "coverage unknown" and
 * default should_owe to 0 — conservative for recovery framing).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanCoverageInput } from "../claims/recovery-math";
import type { ParsedBill } from "../billing/types";
import { buildAcaCoverageFallback } from "./aca-coverage-fallback";
import { normalizeCoinsuranceForStorage } from "../billing/coinsurance";

export type PlanCoverageMap = Map<string, PlanCoverageInput>;

/**
 * S74.6 D2 §B — audit-side ACA fallback. Coverage indexed by line number for
 * uncategorized lines (no slug yet) that hit the ACA registry. Audit rules
 * prefer this map over slug-keyed lookups so F-13 missing_adjustment + F-14
 * insurance_underpayment see covered coverage on ACA-mandated vaccine lines
 * even when D4 hasn't bound a slug to the code.
 */
export type AcaFallbackLineCoverageMap = Map<number, PlanCoverageInput>;

export interface AuditAcaFallback {
  /**
   * Coverage for slug-keyed lookups. Slugs PRESENT in the plan's
   * plan_covered_services are NOT included here (registry only fires on plan
   * miss); callers should merge this into their existing planCoverage map
   * with plan rows winning on key conflict.
   */
  bySlug: PlanCoverageMap;
  /** Per-line coverage for uncategorized lines (slug=null). */
  byLineNumber: AcaFallbackLineCoverageMap;
}

const EMPTY_AUDIT_ACA: AuditAcaFallback = {
  bySlug: new Map(),
  byLineNumber: new Map(),
};

/**
 * S74.6 D2 — Read the plan's `is_aca_compliant` flag for audit rules that
 * want to apply ACA-mandated zero-cost-share fallback. Audit pipeline reads
 * this alongside `loadCoverageMapForPlan` to decide whether to call
 * `buildAcaCoverageFallback` for each bill being evaluated.
 *
 * Returns null when planId is null/missing OR the column isn't populated
 * (legacy pre-mig-093 rows). Audit consumers treat null as "unknown ACA status"
 * → don't apply fallback (conservative: don't synthesize coverage based on
 * an assumption the parser didn't confirm).
 */
export async function loadAcaCompliantFlagForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<boolean | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("insurance_plans")
    .select("is_aca_compliant")
    .eq("id", insurancePlanId)
    .maybeSingle();
  if (error) {
    console.warn("[coverage-loader] aca flag load failed", error);
    return null;
  }
  if (!data) return null;
  return (data.is_aca_compliant as boolean | null) ?? null;
}

/**
 * Thin audit-pipeline wrapper around `buildAcaCoverageFallback`. Converts a
 * `ParsedBill` into the line-item shape the helper expects and returns the
 * resulting bySlug + byLineNumber maps for audit-side merge. Callers MUST
 * have already loaded `planCoverage` so we can filter out lines whose slug
 * is already covered by the plan (registry only fires on plan miss).
 *
 * Returns empty maps when planId/userId missing or plan is not ACA-compliant
 * (mirrors `buildAcaCoverageFallback`'s gate behavior).
 */
export async function loadAcaFallbackForAudit(opts: {
  supabase: SupabaseClient;
  planId: string | null | undefined;
  userId: string | null | undefined;
  patientName: string | null | undefined;
  bill: ParsedBill;
  existingCoverageBySlug: ReadonlySet<string>;
}): Promise<AuditAcaFallback> {
  if (!opts.planId || !opts.userId) return EMPTY_AUDIT_ACA;
  const fallback = await buildAcaCoverageFallback({
    supabase: opts.supabase,
    planId: opts.planId,
    userId: opts.userId,
    patientName: opts.patientName,
    lineItems: opts.bill.lineItems.map((li) => ({
      lineNumber: li.lineNumber,
      procedureCode: li.procedureCode ?? null,
      // BillLineItem doesn't carry a code-type; let the fallback helper infer
      // via inferProcedureCodeType.
      procedureCodeType: null,
      // BillLineItem.category mirrors claim_line_items.service_slug after
      // persist runs the categorization flywheel (S74.5 D6 wiring).
      serviceSlug: li.category ?? null,
    })),
    existingCoverageBySlug: opts.existingCoverageBySlug,
  });
  return {
    bySlug: fallback.bySlug,
    byLineNumber: fallback.byLineNumber,
  };
}

export async function loadCoverageMapForPlan(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<PlanCoverageMap | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, service_catalog!inner(slug)")
    .eq("insurance_plan_id", insurancePlanId);
  if (error) {
    console.warn("[coverage-loader] failed to load coverage for plan", insurancePlanId, error);
    return null;
  }
  const map: PlanCoverageMap = new Map();
  for (const row of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slug = (row.service_catalog as any)?.slug as string | undefined;
    if (!slug) continue;
    map.set(slug, {
      covered: row.covered as boolean | null,
      copay: row.in_copay as number | null,
      // S132 iter-11 — plan_covered_services.in_coinsurance holds either
      // integer percent (30) OR already-decimal (0.3); both mean 30% in
      // plan-document language. normalizeCoinsuranceForStorage handles both
      // formats uniformly. Prior to this, this loader read the raw value
      // expecting decimal — broke for rows the parser wrote as integer.
      coinsurance: normalizeCoinsuranceForStorage(row.in_coinsurance as number | null),
    });
  }
  return map;
}
