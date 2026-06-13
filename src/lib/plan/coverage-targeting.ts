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
import { buildProvenanceEntry, type FieldProvenanceEntry } from "@/lib/parser/field-categories";
import type { MedicalNecessityCriterion, PriorAuthCode, PatternP8Provenance } from "@/lib/eoc/types";

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
  const { cellsWritten } = await upsertServiceCoverage(
    supabase,
    insurancePlanId,
    serviceId,
    { coverageRules: patch },
    { allowBaseCell: false },
  );
  return cellsWritten;
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
export interface UpsertCoverageResult {
  /** Cells patched (update path) or created (base-cell path). */
  cellsWritten: number;
  /**
   * S195: the DB error message when a write FAILED — was silently discarded
   * (`return error ? 0 : 1`), which let a constraint/column failure masquerade
   * as a 0-cell "success" (the bug that hid EOC coverage never landing on a
   * fresh plan). NEVER set on the legitimate `allowBaseCell:false` +
   * no-existing-cell no-op.
   */
  error?: string;
}

export async function upsertServiceCoverage(
  supabase: SupabaseClient,
  insurancePlanId: string,
  serviceId: string,
  patch: ServiceCoveragePatch,
  opts: { allowBaseCell?: boolean; baseDefaults?: BaseCellDefaults } = {},
): Promise<UpsertCoverageResult> {
  const { data: cells } = await supabase
    .from("plan_covered_services")
    .select("id, coverage_rules, field_provenance")
    .eq("insurance_plan_id", insurancePlanId)
    .eq("service_id", serviceId);

  if (cells && cells.length > 0) {
    let written = 0;
    let firstError: string | undefined;
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
      else if (!firstError) firstError = error.message;
    }
    return { cellsWritten: written, error: firstError };
  }

  // No existing cell. For allowBaseCell:false (clinical MN enrich-only) this is
  // a LEGITIMATE no-op — 0 cells, no error.
  if (!opts.allowBaseCell) return { cellsWritten: 0 };

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
  // allowBaseCell:true MUST write a cell; 0 is never legitimate here — surface
  // the real DB error instead of swallowing it as a "0-cell success".
  return error ? { cellsWritten: 0, error: error.message } : { cellsWritten: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// EOC write-once-per-(parse, slug) accumulation (S185 multi-passage clobber fix).
//
// The EOC extractor legitimately emits MULTIPLE facts per service (multi-passage criteria,
// the C1/C2 clinical+PA split), but the per-fact write pattern + `upsertServiceCoverage`'s
// replace-per-key coverage_rules merge meant same-slug facts last-write-won (only the final
// passage survived; field_provenance entries clobbered the same way). This layer matches the
// write contract to the extraction cardinality: collect a parse run's fragments per CANONICAL
// slug, then flush ONE upsert per slug. Merge policies are pure functions (fixtured directly:
// scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-accumulate.ts).
//
// The parse-run boundary lives in the CALLER (process-eoc) — append semantics inside
// `upsertServiceCoverage` instead would double-accumulate on every re-parse. Replace-per-key
// in the helper is correct FOR the write-once contract; this accumulator IS that contract.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One entry per clinical medical_necessity passage (document order preserved). Retains
 * text/dx/excerpt+verified/axis/confidences; extraction-method + section hints live in the slug's
 * field_provenance entry, and pa_polarity is PA-only.
 */
export interface MedicalNecessityCriteriaEntry {
  criteria_text: string;
  diagnosis_qualifiers: string[];
  source_excerpt: MedicalNecessityCriterion["source_excerpt"];
  source_excerpt_verified: MedicalNecessityCriterion["source_excerpt_verified"];
  /** Axis scope when the passage carried one (absent = service-scoped, the common case). */
  place_of_service?: string;
  /** Extraction confidence, when Haiku reported one. */
  haiku_confidence?: number;
  /** P2 classification confidence (flag-OFF arrives as the coerced 0 sentinel = "type defaulted"). */
  type_confidence?: number;
}

function toCriteriaEntry(c: MedicalNecessityCriterion): MedicalNecessityCriteriaEntry {
  return {
    criteria_text: c.criteria_text,
    diagnosis_qualifiers: c.diagnosis_qualifiers,
    source_excerpt: c.source_excerpt,
    source_excerpt_verified: c.source_excerpt_verified,
    ...(c.place_of_service != null ? { place_of_service: c.place_of_service } : {}),
    ...(c.haiku_confidence !== undefined ? { haiku_confidence: c.haiku_confidence } : {}),
    ...(c.type_confidence != null ? { type_confidence: c.type_confidence } : {}),
  };
}

/**
 * Highest extraction confidence cites; ties (and all-undefined) → first (document order).
 * PROSE-PA ONLY: its provenance key is the boolean `prior_auth_required`, which any passage
 * legitimately backs. Clinical provenance cites the FIRST passage instead — its key is
 * `medical_necessity_text`, so the cite must back the exact text the scalar mirrors.
 */
function pickProvenanceSource(
  first: MedicalNecessityCriterion,
  all: MedicalNecessityCriterion[],
): MedicalNecessityCriterion {
  let best = first;
  for (const c of all) {
    if ((c.haiku_confidence ?? -1) > (best.haiku_confidence ?? -1)) best = c;
  }
  return best;
}

export interface MergedCoverageFragment<TSource> {
  coverageRules: Record<string, unknown>;
  /** The fragment whose Pattern P-8 fields the slug's ONE field_provenance entry cites. */
  provenanceSource: TSource;
}

const normText = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Clinical medical-necessity merge: every DISTINCT passage kept — `medical_necessity_criteria[]`
 * (document order; per-passage dx/excerpt/axis/confidence; exact duplicates collapsed, keyed
 * normalized-text + axis so a same-text different-axis fact survives) — plus deterministic scalar
 * mirrors from the FIRST passage (Section-A parity with `prior_auth_criteria`/`_all_criteria`)
 * and `diagnosis_qualifiers` unioned in first-occurrence order across ALL passages (duplicates
 * included). Provenance cites the FIRST passage — the one whose text/excerpt the scalars mirror
 * (key↔value consistency for the cite-grade entry). Replaces last-write-wins.
 */
export function mergeClinicalMnFragments(
  criteria: MedicalNecessityCriterion[],
): MergedCoverageFragment<MedicalNecessityCriterion> | null {
  const first = criteria[0];
  if (!first) return null;
  const dxSeen = new Set<string>();
  const dxUnion: string[] = [];
  for (const c of criteria) {
    for (const dx of c.diagnosis_qualifiers) {
      if (!dxSeen.has(dx)) {
        dxSeen.add(dx);
        dxUnion.push(dx);
      }
    }
  }
  // Exact-duplicate collapse (keep first occurrence): Haiku chunk-overlap re-emission and repeated
  // doc sentences land twice upstream (combineMedicalNecessity is a plain flatMap); the old
  // last-write-wins collapsed them by accident, the accumulate keeps that hygiene deliberately.
  const dupSeen = new Set<string>();
  const kept: MedicalNecessityCriterion[] = [];
  for (const c of criteria) {
    const key = `${normText(c.criteria_text)}|${c.place_of_service ?? ""}`;
    if (dupSeen.has(key)) continue;
    dupSeen.add(key);
    kept.push(c);
  }
  return {
    coverageRules: {
      medical_necessity_text: first.criteria_text,
      diagnosis_qualifiers: dxUnion,
      medical_necessity_source_excerpt: first.source_excerpt,
      medical_necessity_source_excerpt_verified: first.source_excerpt_verified,
      medical_necessity_criteria: kept.map(toCriteriaEntry),
    },
    provenanceSource: first,
  };
}

/**
 * Prose-PA merge (Section B `pa_column`): Section A's exact key family — `prior_auth_criteria` =
 * FIRST passage + `prior_auth_all_criteria[]` = all. One slug = one provenance entry (was:
 * per-criterion entries last-write-winning on `field_provenance.prior_auth_required`).
 */
export function mergeProsePaFragments(
  criteria: MedicalNecessityCriterion[],
): MergedCoverageFragment<MedicalNecessityCriterion> | null {
  const first = criteria[0];
  if (!first) return null;
  // Exact-duplicate collapse (keep first occurrence) — same upstream re-emission hygiene as clinical.
  const seenTexts = new Set<string>();
  const allCriteria: string[] = [];
  for (const c of criteria) {
    const t = normText(c.criteria_text);
    if (seenTexts.has(t)) continue;
    seenTexts.add(t);
    allCriteria.push(c.criteria_text);
  }
  return {
    coverageRules: {
      requires_prior_auth: true,
      prior_auth_criteria: first.criteria_text,
      prior_auth_all_criteria: allCriteria,
      prior_auth_source_excerpt: first.source_excerpt,
      prior_auth_source_excerpt_verified: first.source_excerpt_verified,
    },
    provenanceSource: pickProvenanceSource(first, criteria),
  };
}

/** Section A's per-slug accumulation state (first code anchors; criteria collect in order). */
export interface CodeAnchoredPaAccumulation {
  code: PriorAuthCode;
  criteria: string[];
}

/**
 * Code-anchored PA merge — VERBATIM extraction of Section A's historical inline payload
 * (equivalence-fixtured): anchor = the slug's FIRST code; `prior_auth_criteria` =
 * `criteria[0] ?? code.pa_criteria ?? null`.
 */
export function mergeCodeAnchoredPaFragments(
  acc: CodeAnchoredPaAccumulation,
): MergedCoverageFragment<PriorAuthCode> {
  return {
    coverageRules: {
      requires_prior_auth: true,
      prior_auth_criteria: acc.criteria[0] ?? acc.code.pa_criteria ?? null,
      prior_auth_all_criteria: acc.criteria,
      prior_auth_source_excerpt: acc.code.source_excerpt,
      prior_auth_source_excerpt_verified: acc.code.source_excerpt_verified,
    },
    provenanceSource: acc.code,
  };
}

export type CoverageFlushStatus = "written" | "no_service_id" | "write_failed";

export interface CoverageFlushOutcome<TFragment> {
  slug: string;
  status: CoverageFlushStatus;
  /** The accumulated fragments — callers tally / divert PER FRAGMENT (criterion-denominated G7). */
  fragments: TFragment[];
  /**
   * Cells patched/created on success. 0 is the silent no-op for allowBaseCell:false with no cells —
   * AND the swallowed-supabase-error case (upsertServiceCoverage never throws on DB-level error
   * objects; status stays "written" — carried pre-S185 semantics, locked by fixture; tighten later
   * by mapping 0 → write_failed on the allowBaseCell:true paths where 0 is never legitimate).
   */
  cellsWritten?: number;
  error?: string;
}

/** The Pattern P-8 fields every fragment kind shares — forwarded verbatim to the provenance builder. */
function buildP8Args(s: PatternP8Provenance) {
  return {
    sourceExcerpt: s.source_excerpt,
    sourceExcerptVerified: s.source_excerpt_verified,
    sourceExcerptExtractionMethod: s.source_excerpt_extraction_method,
    sourceSectionHint: s.source_section_hint,
    sourceSectionVerified: s.source_section_verified,
  };
}

/**
 * Document-scoped accumulator: instantiate ONCE per parse (`persistEOCSections`), `add*` inside the
 * section loops, flush per section. TWO flush points by design — Section A flushes before Section B
 * runs (the code-wins `codeAnchoredPaSlugs` dedup is success-gated on A's writes), Section B flushes
 * after its criteria loop. Within Section B, prose-PA flushes BEFORE clinical: PA may create the
 * base cell (`allowBaseCell:true`) that a same-slug clinical write (`allowBaseCell:false`) then
 * lands on — deterministic and retention-maximizing (the old per-criterion writes made this a
 * document-order lottery). Each flush DRAINS its map: a second call of the same flush is a no-op,
 * so double-flush can never double-write or double-tally (single-flush-per-instance, structural).
 */
export class EocCoverageAccumulator {
  private readonly clinical = new Map<string, MedicalNecessityCriterion[]>();
  private readonly prosePa = new Map<string, MedicalNecessityCriterion[]>();
  private readonly codePa = new Map<string, CodeAnchoredPaAccumulation>();

  addClinical(slug: string, criterion: MedicalNecessityCriterion): void {
    const list = this.clinical.get(slug) ?? [];
    list.push(criterion);
    this.clinical.set(slug, list);
  }

  addProsePa(slug: string, criterion: MedicalNecessityCriterion): void {
    const list = this.prosePa.get(slug) ?? [];
    list.push(criterion);
    this.prosePa.set(slug, list);
  }

  /** Section A's `accumulate()`, verbatim: first code anchors; every `pa_criteria` collects in order. */
  addCodeAnchoredPa(slug: string, code: PriorAuthCode): void {
    const acc = this.codePa.get(slug) ?? { code, criteria: [] };
    if (code.pa_criteria) acc.criteria.push(code.pa_criteria);
    this.codePa.set(slug, acc);
  }

  /** Section A flush: typed col + provenance + coverage_rules; base cell allowed (a PA service IS covered). */
  async flushCodeAnchoredPa(
    supabase: SupabaseClient,
    insurancePlanId: string,
  ): Promise<Array<CoverageFlushOutcome<CodeAnchoredPaAccumulation>>> {
    const outcomes: Array<CoverageFlushOutcome<CodeAnchoredPaAccumulation>> = [];
    const codePaEntries = [...this.codePa.entries()];
    this.codePa.clear(); // drain — re-flush is a structural no-op
    for (const [slug, acc] of codePaEntries) {
      const serviceId = await resolveServiceIdBySlug(supabase, slug);
      if (!serviceId) {
        outcomes.push({ slug, status: "no_service_id", fragments: [acc] });
        continue;
      }
      const merged = mergeCodeAnchoredPaFragments(acc);
      const provEntry = buildProvenanceEntry(
        "plan_covered_services",
        "prior_auth_required",
        "doc_extraction_eoc",
        merged.provenanceSource.haiku_confidence,
        buildP8Args(merged.provenanceSource),
      );
      try {
        const { cellsWritten, error } = await upsertServiceCoverage(
          supabase,
          insurancePlanId,
          serviceId,
          {
            typed: { prior_auth_required: true },
            provenance: provEntry ? { prior_auth_required: provEntry } : undefined,
            coverageRules: merged.coverageRules,
          },
          { allowBaseCell: true },
        );
        // S195: a de-swallowed DB error → real write_failed (was reported as
        // "written" with cellsWritten:0 — the bug that hid EOC coverage loss).
        outcomes.push(
          error
            ? { slug, status: "write_failed", fragments: [acc], cellsWritten, error }
            : { slug, status: "written", fragments: [acc], cellsWritten },
        );
      } catch (err) {
        outcomes.push({
          slug,
          status: "write_failed",
          fragments: [acc],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcomes;
  }

  /** Section B prose-PA flush (flag-ON only by routing): one slug = one write + ONE provenance entry. */
  async flushProsePa(
    supabase: SupabaseClient,
    insurancePlanId: string,
  ): Promise<Array<CoverageFlushOutcome<MedicalNecessityCriterion>>> {
    const outcomes: Array<CoverageFlushOutcome<MedicalNecessityCriterion>> = [];
    const prosePaEntries = [...this.prosePa.entries()];
    this.prosePa.clear(); // drain — re-flush is a structural no-op
    for (const [slug, criteria] of prosePaEntries) {
      const merged = mergeProsePaFragments(criteria);
      if (!merged) continue;
      const serviceId = await resolveServiceIdBySlug(supabase, slug);
      if (!serviceId) {
        outcomes.push({ slug, status: "no_service_id", fragments: criteria });
        continue;
      }
      const provEntry = buildProvenanceEntry(
        "plan_covered_services",
        "prior_auth_required",
        "doc_extraction_eoc",
        merged.provenanceSource.haiku_confidence,
        buildP8Args(merged.provenanceSource),
      );
      try {
        const { cellsWritten, error } = await upsertServiceCoverage(
          supabase,
          insurancePlanId,
          serviceId,
          {
            typed: { prior_auth_required: true },
            provenance: provEntry ? { prior_auth_required: provEntry } : undefined,
            coverageRules: merged.coverageRules,
          },
          { allowBaseCell: true },
        );
        outcomes.push(
          error
            ? { slug, status: "write_failed", fragments: criteria, cellsWritten, error }
            : { slug, status: "written", fragments: criteria, cellsWritten },
        );
      } catch (err) {
        outcomes.push({
          slug,
          status: "write_failed",
          fragments: criteria,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcomes;
  }

  /**
   * Section B clinical flush: EXISTING cells only (no phantom covered row — unchanged) + the NEW
   * cite-grade `medical_necessity_text` provenance entry (the dormant field-categories
   * `eoc_authoritative` tag was the forward declaration; this is its first writer).
   */
  async flushClinicalMn(
    supabase: SupabaseClient,
    insurancePlanId: string,
  ): Promise<Array<CoverageFlushOutcome<MedicalNecessityCriterion>>> {
    const outcomes: Array<CoverageFlushOutcome<MedicalNecessityCriterion>> = [];
    const clinicalEntries = [...this.clinical.entries()];
    this.clinical.clear(); // drain — re-flush is a structural no-op
    for (const [slug, criteria] of clinicalEntries) {
      const merged = mergeClinicalMnFragments(criteria);
      if (!merged) continue;
      const serviceId = await resolveServiceIdBySlug(supabase, slug);
      if (!serviceId) {
        outcomes.push({ slug, status: "no_service_id", fragments: criteria });
        continue;
      }
      const provEntry = buildProvenanceEntry(
        "plan_covered_services",
        "medical_necessity_text",
        "doc_extraction_eoc",
        merged.provenanceSource.haiku_confidence,
        buildP8Args(merged.provenanceSource),
      );
      try {
        // allowBaseCell:false — clinical MN enriches EXISTING cells only;
        // cellsWritten:0 with NO error is the legitimate no-op (no cell yet).
        const { cellsWritten, error } = await upsertServiceCoverage(
          supabase,
          insurancePlanId,
          serviceId,
          {
            provenance: provEntry ? { medical_necessity_text: provEntry } : undefined,
            coverageRules: merged.coverageRules,
          },
          { allowBaseCell: false },
        );
        outcomes.push(
          error
            ? { slug, status: "write_failed", fragments: criteria, cellsWritten, error }
            : { slug, status: "written", fragments: criteria, cellsWritten },
        );
      } catch (err) {
        outcomes.push({
          slug,
          status: "write_failed",
          fragments: criteria,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcomes;
  }
}
