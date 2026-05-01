/**
 * DR-3A field categories + source-of-truth hierarchy (Q-DR-3A-1 through Q-DR-3A-6).
 *
 * Maps every persisted field to a `FieldCategory` (via TABLE_DEFAULT_CATEGORY for the
 * common case and FIELD_EXCEPTIONS for known carve-outs). Each category has its own
 * SOURCE_PROVENANCE precedence list — when two writes conflict on the same field,
 * the higher-ranked source wins.
 *
 * V1 storage: TypeScript const (per Q-DR-3A-1). Migration to DB catalog/hybrid only
 * if we need ≥3 edits without PR cycles in a single sprint.
 *
 * Adding a NEW normalizer type or category post-Phase-3 requires Subplan revision per
 * Q-DR-3A-3 (bounds scope creep).
 *
 * See plans/phase_3_parse_strategy_refactor.md DR-3A locked decisions.
 */

import type { SourceExcerptVerified, ExtractionMethod } from "./types";

export type FieldCategory =
  | "sbc_authoritative"
  | "eoc_authoritative" // Phase 3.1A: EOC > SBC for PA criteria, medical necessity, appeals procedures, COB rules, eligibility rules, definitions
  | "bill_monetary"
  | "bill_identity_place"
  | "calculated_with_provenance"
  | "reference_data"
  | "identity_split";

export type SourceProvenance =
  | "admin_verified"
  | "user_correction"
  | "multi_source_corroboration"
  | "state_filing"
  | "cms_marketplace"
  | "sbe_ingest"
  | "nppes"
  | "irs_990_h"
  | "doc_extraction"
  | "doc_extraction_eoc" // Phase 3.1A: EOC parser distinct from SBC/plan_document doc_extraction
  | "card_corroboration"
  | "bill_observed"
  | "user_reported_outcome"
  | "user_initial_entry"
  | "carrier_product_line_skeleton"
  | "peo_inference"
  | "legacy_unverified"
  | "provider_submitted";

/**
 * Per Pattern 1 Confidence Mapping Table (locked in Candid_Data_Patterns Pattern 1
 * Component 5). First-write source defaults; multi-source corroboration boosts via
 * the existing Pattern 1 #3 mechanism.
 */
export const SOURCE_DEFAULT_CONFIDENCE: Record<SourceProvenance, number> = {
  admin_verified: 1.0,
  user_correction: 0.9,
  multi_source_corroboration: 0.9,
  state_filing: 0.9,
  cms_marketplace: 0.85,
  sbe_ingest: 0.8,
  nppes: 0.85,
  irs_990_h: 0.8,
  doc_extraction: 0.5,
  doc_extraction_eoc: 0.5, // Phase 3.1A: same baseline as doc_extraction; cross-source corroboration boosts via Pattern 1 #3
  card_corroboration: 0.6,
  bill_observed: 0.5,
  user_reported_outcome: 0.5,
  user_initial_entry: 0.5,
  provider_submitted: 0.7,
  carrier_product_line_skeleton: 0.4,
  peo_inference: 0.3,
  legacy_unverified: 0.2,
};

/**
 * Default category for tables that aren't carved out. Per Q-DR-3A-6.
 * Most rows on a given table share a category; FIELD_EXCEPTIONS handles outliers.
 */
export const TABLE_DEFAULT_CATEGORY: Record<string, FieldCategory> = {
  canonical_plan_services: "sbc_authoritative",
  plan_covered_services: "sbc_authoritative",
  claim_line_items: "bill_monetary",
  claims: "bill_monetary",
  insurer_catalog: "reference_data",
  providers: "reference_data",
};

/**
 * Per-field overrides for known carve-outs. Key format: `<table>.<column>`.
 * Per Q-DR-3A-4-final (bill split) + Q-DR-3A-5-final (actuarial_value transparency).
 */
export const FIELD_EXCEPTIONS: Record<string, FieldCategory> = {
  // Q-DR-3A-5-final: AV uses calculated_with_provenance (regulatory > empirical;
  // empirical lives in separate `actuarial_value_empirical` column).
  "insurance_plans.actuarial_value": "calculated_with_provenance",

  // Identity-split: insurer name has BOTH verbatim (preserve user-typed) and canonical
  // (normalized for matching) — write to two columns; no conflict resolution needed.
  "insurance_plans.insurer_name_verbatim": "identity_split",
  "insurance_plans.insurer_name_canonical": "identity_split",

  // Q-DR-3A-4-final: bill identity/place fields trust the BILL (provider's claim) over
  // the EOB (insurer's record) — providers know who/where; insurers know $$.
  "claim_line_items.provider_npi": "bill_identity_place",
  "claim_line_items.place_of_service": "bill_identity_place",
  "claim_line_items.rendering_provider_name": "bill_identity_place",
  "claim_line_items.service_date": "bill_identity_place",

  // Phase 3.1A Q-P3.1A-8: EOC > SBC for citation-grade authority on these fields.
  // SBC has standardized 8-page summary; EOC has full regulatory text. Dispute letters
  // cite EOC verbatim for PA criteria, medical necessity, appeals procedures, etc.
  // Per-field FIELD_EXCEPTIONS land where EOC outranks SBC; default sbc_authoritative
  // category covers cost-sharing matrix where SBC > EOC.
  // JSONB-keyed fields (e.g., plan_covered_services.coverage_rules.requires_prior_auth):
  // category lookup uses the JSONB column name; consumer-read parses the inner key.
  "plan_covered_services.coverage_rules": "eoc_authoritative",
  "plan_covered_services.medical_necessity_text": "eoc_authoritative",
  "plan_covered_services.requires_prior_auth": "eoc_authoritative",
  "insurance_plans.appeals_internal_timing_days": "eoc_authoritative",
  "insurance_plans.cob_primary_determination_method": "eoc_authoritative",
  "insurance_plans.eligibility_dependent_age_limit": "eoc_authoritative",
};

/**
 * Precedence order — leftmost wins for conflict resolution within a category.
 * Per DR-3A locked decisions Q-DR-3A-4-final + Q-DR-3A-5-final.
 */
export const CATEGORY_HIERARCHY: Record<FieldCategory, SourceProvenance[]> = {
  sbc_authoritative: [
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "doc_extraction", // SBC primary
    "doc_extraction_eoc", // EOC fallback for cost-sharing matrix (SBC > EOC for these fields)
    "card_corroboration",
    "bill_observed",
  ],
  eoc_authoritative: [
    // Phase 3.1A: PA criteria, medical necessity, appeals procedures, COB rules,
    // eligibility rules, definitions — EOC is citation-grade; SBC is summary-only.
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "doc_extraction_eoc", // EOC primary
    "doc_extraction", // SBC fallback (rarely populates these fields)
    "card_corroboration",
    "bill_observed",
  ],
  bill_monetary: [
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "doc_extraction", // EOB extraction (insurer authoritative for $$)
    "bill_observed", // bill extraction (provider claim)
  ],
  bill_identity_place: [
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "bill_observed", // bill extraction (provider authoritative for who/where)
    "doc_extraction", // EOB (insurer might have stale data)
  ],
  calculated_with_provenance: [
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "state_filing", // CMS HHS calculator output (regulatory truth)
    "cms_marketplace", // HIOS API
    "doc_extraction", // SBC-stated
    "carrier_product_line_skeleton", // naming convention inference
  ],
  reference_data: [
    "admin_verified",
    "user_correction",
    "multi_source_corroboration",
    "nppes",
    "cms_marketplace",
    "state_filing",
    "doc_extraction",
  ],
  identity_split: [], // No conflict — write to two columns
};

/**
 * Resolve the FieldCategory for a given (table, column). FIELD_EXCEPTIONS take
 * precedence over TABLE_DEFAULT_CATEGORY. Logs a warning if neither matches so we
 * can iterate on the maps from production telemetry per Q-DR-3A-6.
 *
 * Returns null for uncategorized fields — callers should NOT include uncategorized
 * fields in field_provenance JSONB writes (their confidence shouldn't enter the row
 * MIN computation per Q-DR-3B-2).
 */
export function lookupCategory(table: string, column: string): FieldCategory | null {
  const exceptionKey = `${table}.${column}`;
  if (exceptionKey in FIELD_EXCEPTIONS) {
    return FIELD_EXCEPTIONS[exceptionKey];
  }
  if (table in TABLE_DEFAULT_CATEGORY) {
    return TABLE_DEFAULT_CATEGORY[table];
  }
  console.warn(`[field-categories] Uncategorized field write: ${exceptionKey} — using SOURCE_RANK_DEFAULT`);
  return null;
}

/**
 * Per-field provenance entry. Stored as a value inside the JSONB column
 * `field_provenance` keyed by column name.
 *
 * `confidence` = SOURCE_DEFAULT_CONFIDENCE[source] at write time; mutates upward via
 * Pattern 1 #3 corroboration. Per Q-DR-3B-3-FLIPPED, decay is computed lazily on
 * read (not stored).
 *
 * `haiku_confidence` = self-reported per-field confidence from Haiku _meta block.
 * METADATA ONLY per Q-DR-3B-1 — never auto-blended into `confidence`. Preserved for
 * Phase 6 calibration analysis.
 */
export interface FieldProvenanceEntry {
  source: SourceProvenance;
  confidence: number; // 0-1
  last_corroborated_at: string; // ISO timestamp
  haiku_confidence?: number; // 0-1, optional
  // Pattern P-8 (Phase 3.1B) — citation-grade source provenance.
  // All 5 fields optional: present only when the parser writes them under
  // `parse_strategy_v2` flag ON. Stripped from `claim_line_items_aggregate` view (mig 058).
  source_excerpt?: string;
  source_excerpt_verified?: SourceExcerptVerified;
  source_excerpt_extraction_method?: ExtractionMethod;
  source_section_hint?: string;
  source_section_verified?: boolean;
}

/**
 * Build a FieldProvenanceEntry for a fresh extraction. Returns null when the field
 * isn't categorized (callers should skip including it in field_provenance per the
 * lookupCategory contract).
 *
 * Pattern P-8 fields (sourceExcerpt + verified + extractionMethod + sectionHint +
 * sectionVerified) are optional; pass them when `parse_strategy_v2` flag is ON
 * AND the upstream parser captured + verified them.
 */
export function buildProvenanceEntry(
  table: string,
  column: string,
  source: SourceProvenance,
  haikuConfidence?: number,
  patternP8?: {
    sourceExcerpt?: string;
    sourceExcerptVerified?: SourceExcerptVerified;
    sourceExcerptExtractionMethod?: ExtractionMethod;
    sourceSectionHint?: string;
    sourceSectionVerified?: boolean;
  },
): FieldProvenanceEntry | null {
  const category = lookupCategory(table, column);
  if (!category) return null;

  const entry: FieldProvenanceEntry = {
    source,
    confidence: SOURCE_DEFAULT_CONFIDENCE[source],
    last_corroborated_at: new Date().toISOString(),
  };
  if (haikuConfidence !== undefined) entry.haiku_confidence = haikuConfidence;

  if (patternP8) {
    if (patternP8.sourceExcerpt !== undefined) entry.source_excerpt = patternP8.sourceExcerpt;
    if (patternP8.sourceExcerptVerified !== undefined) entry.source_excerpt_verified = patternP8.sourceExcerptVerified;
    if (patternP8.sourceExcerptExtractionMethod !== undefined) {
      entry.source_excerpt_extraction_method = patternP8.sourceExcerptExtractionMethod;
    }
    if (patternP8.sourceSectionHint !== undefined) entry.source_section_hint = patternP8.sourceSectionHint;
    if (patternP8.sourceSectionVerified !== undefined) entry.source_section_verified = patternP8.sourceSectionVerified;
  }

  return entry;
}
