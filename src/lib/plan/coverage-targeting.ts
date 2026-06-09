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
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";

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
  return upsertServiceCoverage(
    supabase,
    insurancePlanId,
    serviceId,
    { coverageRules: patch },
    { allowBaseCell: false },
  );
}

/** Resolve a service slug to its `service_catalog` id (null when the slug isn't in the catalog). */
export async function resolveServiceIdBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("service_catalog")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * A coverage assertion to apply across every user-side cell of a service.
 *  - `typed`: typed columns set on each cell (e.g. `{ prior_auth_required: true }`).
 *  - `coverageRules`: JSONB merged into `coverage_rules` (never clobbers existing keys).
 *  - `provenance`: `field_provenance` entries merged per field-name (cite-grade parity).
 */
export interface ServiceCoveragePatch {
  typed?: Record<string, unknown>;
  coverageRules?: Record<string, unknown>;
  provenance?: Record<string, FieldProvenanceEntry>;
}

/** Defaults for a freshly-created base cell (used only when the service has no cell yet). */
export interface BaseCellDefaults {
  /** `plan_covered_services.source` CHECK value; EOC ≈ 'plan_doc_parsed'. */
  source?: string;
  /** Single-source default per Rule #8. */
  confidence?: number;
  /** Column default is true — a PA / medical-necessity service IS covered (conditionally). */
  covered?: boolean;
}

/**
 * Apply a coverage assertion to a service's user-side cells, on the REAL columns
 * (`insurance_plan_id`, `service_id`). The single sanctioned writer of EOC `coverage_rules` +
 * the EOC-authoritative typed `prior_auth_required` column + its `field_provenance`.
 *
 *   - cells exist            → patch EVERY cell (typed cols + coverage_rules merge + field_provenance
 *                              merge), so the reader (reads off whichever cell it renders) sees it on all.
 *   - none AND allowBaseCell → create ONE base `(any, global)` cell carrying the patch.
 *
 * Returns the number of cells written (0 when none existed and `allowBaseCell` is false).
 *
 * Supersedes process-eoc's removed `mergeCoverageRules`, which filtered/inserted the NON-EXISTENT
 * `plan_id`/`service_slug` columns → supabase-js returned an unchecked error object → silent no-op
 * (every EOC prior-auth / medical-necessity write was dropped). `mergeServiceCoverageRules` delegates here.
 */
export async function upsertServiceCoverage(
  supabase: SupabaseClient,
  insurancePlanId: string,
  serviceId: string,
  patch: ServiceCoveragePatch,
  opts: { allowBaseCell?: boolean; baseDefaults?: BaseCellDefaults } = {},
): Promise<number> {
  const { data: cells } = await supabase
    .from("plan_covered_services")
    .select("id, coverage_rules, field_provenance")
    .eq("insurance_plan_id", insurancePlanId)
    .eq("service_id", serviceId);

  if (cells && cells.length > 0) {
    let written = 0;
    for (const cell of cells) {
      const update: Record<string, unknown> = { ...(patch.typed ?? {}) };
      if (patch.coverageRules) {
        const existing = (cell.coverage_rules as Record<string, unknown> | null) ?? {};
        update.coverage_rules = { ...existing, ...patch.coverageRules };
      }
      if (patch.provenance) {
        const existing = (cell.field_provenance as Record<string, unknown> | null) ?? {};
        update.field_provenance = { ...existing, ...patch.provenance };
      }
      if (Object.keys(update).length === 0) continue;
      const { error } = await supabase
        .from("plan_covered_services")
        .update(update)
        .eq("id", cell.id as string);
      if (!error) written++;
    }
    return written;
  }

  if (!opts.allowBaseCell) return 0;

  const base: PlanCoverageRow = {
    insurance_plan_id: insurancePlanId,
    service_id: serviceId,
    place_of_service: "any",
    component: "global",
    covered: opts.baseDefaults?.covered ?? true,
    source: opts.baseDefaults?.source ?? "plan_doc_parsed",
    confidence: opts.baseDefaults?.confidence ?? 0.5,
    ...(patch.typed ?? {}),
    ...(patch.coverageRules ? { coverage_rules: patch.coverageRules } : {}),
    ...(patch.provenance ? { field_provenance: patch.provenance } : {}),
  };
  const { error } = await applyPlanCoverageCell(supabase, base);
  return error ? 0 : 1;
}
