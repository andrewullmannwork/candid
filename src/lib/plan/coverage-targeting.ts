/**
 * Coverage-cell targeting (Service Thesaurus Phase 1a — T4 / mig 157).
 *
 * Pattern S (Hard Rule #17): a user-side coverage row is a CELL identified by
 * `(insurance_plan_id, service_id, place_of_service, component)` — mig 157 re-keyed
 * the `plan_covered_services` UNIQUE to these four columns (parity with
 * `canonical_plan_services.uq_canonical_plan_service`, mig 147).
 *
 * This module is the SINGLE write surface for that table. Routing every upsert through
 * `applyPlanCoverageCell` makes the 4-col conflict key the one source of truth and makes a
 * missing-axis write a COMPILE error (`PlanCoverageRow` requires place_of_service + component) —
 * structurally closing the over-broad-write class the §2 F5 audit found.
 *
 * NOTE: canonical_plan_services is NOT written here. Admin/corroboration canonical writes go
 * through `applyPromotionEvent` (promotion-event.ts), which is cell-aware (4-col) AND keeps the
 * typed column + field_provenance in sync atomically (S135 Path B). A raw canonical upsert helper
 * would re-introduce that drift, so it is deliberately absent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Billing-grounded component modifier (mirrors the plan_covered_services / mig 147 CHECK). */
export type CoverageComponent = "facility" | "professional" | "global";

/**
 * The 4-col conflict target for plan_covered_services (mig 157 `uq_plan_covered_service`).
 * The single source of truth — never inline this string at a call site.
 */
export const PLAN_COVERED_ONCONFLICT =
  "insurance_plan_id,service_id,place_of_service,component";

/**
 * A user-side coverage cell. `place_of_service` + `component` are REQUIRED: omitting either is a
 * compile error, which is the invariant that makes over-broad writes impossible. Remaining
 * cost/flag/provenance fields ride through the index signature.
 */
export interface PlanCoverageRow {
  insurance_plan_id: string;
  service_id: string;
  place_of_service: string;
  component: CoverageComponent;
  [field: string]: unknown;
}

/**
 * Coerce a parser-emitted component to the CHECK vocab. Returns 'global' for null/undefined/unknown
 * — so flag-OFF (where the extractor emits no component, T2) is byte-identical 'global', and flag-ON
 * non-global values pass through. Never throws.
 */
export function coerceComponent(v: unknown): CoverageComponent {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  return s === "facility" || s === "professional" ? s : "global";
}

/**
 * Upsert one or many coverage cells via the 4-col conflict key. The ONLY sanctioned writer of
 * plan_covered_services cost rows.
 */
export async function applyPlanCoverageCell(
  supabase: SupabaseClient,
  rows: PlanCoverageRow | PlanCoverageRow[],
) {
  const arr = Array.isArray(rows) ? rows : [rows];
  return supabase
    .from("plan_covered_services")
    .upsert(arr, { onConflict: PLAN_COVERED_ONCONFLICT });
}

/**
 * Merge a JSONB patch into `coverage_rules` across ALL cells of a service.
 *
 * Service-level attributes (e.g. `how_to_access` — a network-finder URL/phone that applies to the
 * whole service, not one cost cell) live in `coverage_rules` on the cell rows, and the reader
 * (`/api/plan/analyze`) reads them off WHICHEVER cell it renders. So we stamp every cell uniformly.
 * This also fixes the post-4-col `.maybeSingle()` multi-row throw: a service may now have several
 * cells, so we select them all and patch each. Idempotent; merges (never clobbers other keys).
 *
 * @returns number of cells patched (0 if the service has no coverage row yet — unchanged no-op).
 */
export async function mergeServiceCoverageRules(
  supabase: SupabaseClient,
  insurancePlanId: string,
  serviceId: string,
  patch: Record<string, unknown>,
): Promise<number> {
  const { data: cells } = await supabase
    .from("plan_covered_services")
    .select("id, coverage_rules")
    .eq("insurance_plan_id", insurancePlanId)
    .eq("service_id", serviceId);

  if (!cells || cells.length === 0) return 0;

  let patched = 0;
  for (const cell of cells) {
    const existing = (cell.coverage_rules as Record<string, unknown> | null) ?? {};
    const { error } = await supabase
      .from("plan_covered_services")
      .update({ coverage_rules: { ...existing, ...patch } })
      .eq("id", cell.id as string);
    if (!error) patched++;
  }
  return patched;
}
