/**
 * S74.6 D2 — Demographic-aware ACA-compliance-gated coverage fallback.
 *
 * When the user's `plan_covered_services` has no row for a line's `service_slug`
 * AND the plan is ACA-compliant (`is_aca_compliant=TRUE` per mig 093 / D1)
 * AND the line's billing code hits `zero_cost_share_codes` (ACA-preventive or ACIP-vaccine)
 * AND demographic eligibility matches (age_min/age_max/sex from the registry row)
 * THEN synthesize coverage = `{ covered: true, copay: 0, coinsurance: 0, source: 'aca_zero_cost_share' }`.
 *
 * Consumers:
 *   1. `/api/claims/[claimId]/route.ts` — surfaces "Covered · $0" in the Coverage column
 *      for line items where the plan doesn't have an explicit coverage row but the
 *      federal mandate applies (e.g., Andrew's Cigna ACA-compliant plan + a vaccine
 *      that's missing from his parsed SBC's services list).
 *   2. `src/lib/audit/coverage-loader.ts` — under the `acaGatedPlan` flag, threads
 *      the synthesized coverage into the audit pipeline so F-13 missing_adjustment,
 *      F-14 insurance_underpayment, etc. compute should_owe=0 for ACA-mandated services
 *      and don't falsely fire (or do correctly fire, depending on the rule's intent).
 *
 * Plan-coverage WINS over ACA fallback (Subplan §5.2 mitigation): when
 * `plan_covered_services` HAS a row — even one with a non-zero copay — that row
 * supersedes the fallback. Registry fallback only fires on plan miss.
 *
 * Grandfathered plans (`is_aca_compliant=FALSE`) and unknown-basis plans where the
 * user has overridden via the upload-confirmation page are EXCLUDED automatically by
 * the flag gate. The audit-side `zero_cost_share_overcharge` finding (S74.5 D13) still
 * fires informationally for transparency — D2 only changes the rendered coverage badge.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanCoverageInput } from "../claims/recovery-math";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import {
  fetchPatientDemographics,
  demographicEligible,
} from "./zero-cost-share";

export interface AcaFallbackLineItem {
  /** 1-indexed line position on the bill. */
  lineNumber: number;
  /** Billing code as captured at parse time. */
  procedureCode: string | null;
  /** Procedure code type (e.g., 'CPT' | 'HCPCS_L2' | 'G_CODE' | 'CAT_II'). When null, the helper infers via D0. */
  procedureCodeType: string | null;
  /** Resolved service slug. May be null on uncategorized lines — D4 covers those. */
  serviceSlug: string | null;
}

export interface AcaFallbackResult {
  /**
   * Slug-keyed coverage entries — drop-in additions to the route's existing
   * `coverageMap` (slug → coverage). When a line has a slug AND the fallback
   * fires, the slug-coverage pair lands here.
   */
  bySlug: Map<string, PlanCoverageInput>;
  /**
   * Line-number-keyed coverage entries — drop-in fallback for uncategorized
   * lines (slug=null) so the Coverage column can still render "Covered · $0"
   * when D4 hasn't yet bound a slug to the code.
   */
  byLineNumber: Map<number, PlanCoverageInput>;
  /**
   * S74.6 D1 §A.2 — plan-level ACA basis + excerpt for Coverage badge tooltip
   * copy. Populated whenever `is_aca_compliant=TRUE`, even when no fallback
   * coverage fires (consumers can check `bySlug.size + byLineNumber.size === 0`
   * to detect that). `null` when the plan is not ACA-compliant or planId/userId
   * missing.
   */
  planMeta: {
    isAcaCompliant: boolean;
    basis: string | null;
    excerpt: string | null;
  } | null;
}

const EMPTY_RESULT: AcaFallbackResult = {
  bySlug: new Map(),
  byLineNumber: new Map(),
  planMeta: null,
};

const CODE_TYPE_NAMESPACE_WHITELIST = new Set([
  "CPT",
  "HCPCS_L2",
  "G_CODE",
  "CAT_II",
]);

interface ZcsLookupRow {
  billing_code: string;
  billing_code_type: string;
  age_min: number | null;
  age_max: number | null;
  sex: "M" | "F" | null;
  source_url: string;
  source_label: string;
  display_name: string;
  coverage_basis: "ACA_preventive" | "ACIP_vaccine";
}

/**
 * Build the ACA-gated coverage fallback map for a set of bill line items.
 * Returns EMPTY_RESULT immediately when the plan is not ACA-compliant — fastest
 * possible no-op for grandfathered + user-override-FALSE plans.
 */
export async function buildAcaCoverageFallback(opts: {
  supabase: SupabaseClient;
  planId: string | null | undefined;
  userId: string | null | undefined;
  patientName: string | null | undefined;
  lineItems: readonly AcaFallbackLineItem[];
  /**
   * Set of slugs already covered by `plan_covered_services`. The fallback skips
   * any line whose slug is in this set — explicit plan coverage wins.
   */
  existingCoverageBySlug: ReadonlySet<string>;
}): Promise<AcaFallbackResult> {
  if (!opts.planId || !opts.userId) return EMPTY_RESULT;
  if (opts.lineItems.length === 0) return EMPTY_RESULT;

  // Plan ACA-compliance gate (D1 column from mig 093).
  const { data: planRow } = await opts.supabase
    .from("insurance_plans")
    .select("is_aca_compliant, aca_compliance_basis, aca_compliance_excerpt")
    .eq("id", opts.planId)
    .maybeSingle();
  if (planRow?.is_aca_compliant !== true) return EMPTY_RESULT;

  // §A.2 plan-level metadata for downstream tooltip rendering. Carried even
  // when the per-line fallback finds no matching codes (consumers can still
  // need the basis copy when surfacing the registry status to the user).
  const planMeta: AcaFallbackResult["planMeta"] = {
    isAcaCompliant: true,
    basis: (planRow.aca_compliance_basis as string | null) ?? null,
    excerpt: (planRow.aca_compliance_excerpt as string | null) ?? null,
  };

  // Candidate lines: have a billing code AND (no slug OR slug not in existing coverage).
  // Grandfathered + non-compliant plans already filtered above; remaining lines
  // need either an unbound slug or a slug-missing-from-plan-services to qualify.
  const candidates = opts.lineItems.filter(
    (li) =>
      li.procedureCode &&
      (!li.serviceSlug || !opts.existingCoverageBySlug.has(li.serviceSlug)),
  );
  if (candidates.length === 0) return EMPTY_RESULT;

  // Single batch query against zero_cost_share_codes — small fanout per bill.
  // billing_code IN (...) is a coarse pre-filter; we narrow to the exact
  // (code, code_type) pair in the per-line loop below.
  const distinctCodes = Array.from(
    new Set(
      candidates
        .map((c) => c.procedureCode)
        .filter((code): code is string => Boolean(code)),
    ),
  );
  const { data: zcsRowsRaw, error } = await opts.supabase
    .from("zero_cost_share_codes")
    .select(
      "billing_code, billing_code_type, age_min, age_max, sex, source_url, source_label, display_name, coverage_basis",
    )
    .in("billing_code", distinctCodes)
    .is("retired_at", null);
  if (error) {
    console.warn("[aca-coverage-fallback] zcs lookup failed", error);
    return EMPTY_RESULT;
  }
  if (!zcsRowsRaw || zcsRowsRaw.length === 0) return EMPTY_RESULT;
  const zcsRows = zcsRowsRaw as ZcsLookupRow[];

  // Demographics — one fetch per audit/route invocation, reused across all lines.
  const demographics = await fetchPatientDemographics(
    opts.userId,
    opts.patientName,
  );

  const result: AcaFallbackResult = {
    bySlug: new Map(),
    byLineNumber: new Map(),
    planMeta,
  };

  for (const cand of candidates) {
    if (!cand.procedureCode) continue;
    const codeType = cand.procedureCodeType ?? inferProcedureCodeType(cand.procedureCode);
    if (!codeType || !CODE_TYPE_NAMESPACE_WHITELIST.has(codeType)) continue;

    const matching = zcsRows.find(
      (r) =>
        r.billing_code === cand.procedureCode &&
        r.billing_code_type === codeType &&
        demographicEligible(
          { age_min: r.age_min, age_max: r.age_max, sex: r.sex },
          demographics,
        ),
    );
    if (!matching) continue;

    const coverage: PlanCoverageInput = {
      covered: true,
      copay: 0,
      coinsurance: 0,
      // ACA preventive is deductible-exempt by law (cost-share v2 / S214).
      deductibleApplies: false,
    };
    result.byLineNumber.set(cand.lineNumber, coverage);
    if (cand.serviceSlug) result.bySlug.set(cand.serviceSlug, coverage);
  }

  return result;
}
