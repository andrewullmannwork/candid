/**
 * Shared provenance builders — Phase 3.2.1 (Q-P3.2.1-1 through Q-P3.2.1-5).
 *
 * Produces field_provenance JSONB payloads for:
 *   - plan_covered_services rows (SBC service writes, one shared excerpt across fields)
 *   - canonical_plan_services rows (SBC canonical seeds, narrower column set)
 *   - insurance_plans rows (SBC plan-identity = per-field excerpts; EOC plan-identity = no excerpts)
 *
 * Mirrors the bills/EOBs reference implementation (`buildLineItemProvenance` in
 * `src/lib/claims/persist.ts`). Single source of truth for JSONB shape:
 * `buildProvenanceEntry()` from `field-categories.ts` produces every per-field entry.
 *
 * Pattern P-8 contract (Q-P3.2.1-4): each entry carries 5 sub-keys when patternP8 is
 * present (source_excerpt + verified + extraction_method + section_hint + section_verified).
 * EOC plan-identity comes from regex extraction (plan-doc-parser.ts via Q-P3.1A-11)
 * with no patternP8 — entry written without sub-keys is still valid + corroborates via
 * Pattern 1 #3.
 *
 * Q-P3.2.1-5: SBC service rows share ONE source_excerpt across all cost-sharing fields
 * (the full table-row text covers each value transitively). 87.3% verified rate locked
 * at this granularity (Phase 3.2 iter 6 baseline).
 */

import type { FieldProvenanceEntry, SourceProvenance } from "./field-categories";
import { buildProvenanceEntry } from "./field-categories";
import type { PatternP8Provenance } from "./verify-source-excerpts";
import type { SBCHaikuService, SBCPlanIdentity } from "@/lib/sbc/types";
import type { EOCPlanIdentity } from "@/lib/eoc/types";

/**
 * Translate the snake_case PatternP8Provenance shape (parser-side) into the camelCase
 * shape buildProvenanceEntry expects. Returns undefined when patternP8 is absent
 * (e.g., legacy regex extraction paths).
 */
function adaptPatternP8(
  p8: PatternP8Provenance | undefined,
): Parameters<typeof buildProvenanceEntry>[4] | undefined {
  if (!p8) return undefined;
  return {
    sourceExcerpt: p8.source_excerpt,
    sourceExcerptVerified: p8.source_excerpt_verified,
    sourceExcerptExtractionMethod: p8.source_excerpt_extraction_method,
    sourceSectionHint: p8.source_section_hint,
    sourceSectionVerified: p8.source_section_verified,
  };
}

/**
 * Build field_provenance for a `plan_covered_services` row from an SBC service.
 *
 * One source_excerpt (Q-P3.2.1-5) — the full row text — applies to every cost-sharing
 * field on the row. All entries share `service.patternP8` + `service.haikuConfidence`.
 * Uncategorized columns are silently skipped (lookupCategory returns null).
 *
 * Phase 4.0.5: `searchedSections` (parser-level `dispatchedSections`) propagates to
 * every field for forward-compat verbatim_absent derivation + targeted re-parse.
 */
export function buildPlanCoveredServiceProvenance(
  service: SBCHaikuService,
  source: SourceProvenance = "doc_extraction",
  searchedSections?: string[],
): Record<string, FieldProvenanceEntry> {
  const patternP8 = adaptPatternP8(service.patternP8);
  const haikuConfidence = service.haikuConfidence;

  // (column_name, value) pairs for every plan_covered_services column the SBC parser
  // populates. Fields with null/undefined values are skipped — we don't write
  // provenance for fields we didn't capture.
  const fields: Array<[string, unknown]> = [
    ["in_copay", service.inCopay],
    ["in_coinsurance", service.inCoinsurance],
    ["in_deductible_applies", service.inDeductibleApplies],
    ["in_copay_waiver_condition", service.inCopayWaiverCondition],
    ["in_cost_description", service.inCostDescription],
    ["out_copay", service.outCopay],
    ["out_coinsurance", service.outCoinsurance],
    ["out_deductible_applies", service.outDeductibleApplies],
    ["out_cost_description", service.outCostDescription],
    ["oon_paid_at_in_network", service.oonPaidAtInNetwork],
    ["annual_limit", service.annualLimit],
    ["annual_limit_value", service.annualLimitValue],
    ["prior_auth_required", service.priorAuthRequired],
    ["penalty_no_precert", service.penaltyNoPrecert],
    ["covered", service.covered],
    ["coverage_conditions", service.coverageConditions],
    ["supply_limit_days", service.supplyLimitDays],
    ["home_delivery_copay", service.homeDeliveryCopay],
    ["step_therapy_required", service.stepTherapyRequired],
    ["notes", service.notes],
  ];

  const provenance: Record<string, FieldProvenanceEntry> = {};
  for (const [column, value] of fields) {
    if (value === null || value === undefined || value === "") continue;
    const entry = buildProvenanceEntry(
      "plan_covered_services",
      column,
      source,
      haikuConfidence,
      patternP8,
      searchedSections,
    );
    if (entry) provenance[column] = entry;
  }
  return provenance;
}

/**
 * Build field_provenance for a `canonical_plan_services` row.
 *
 * Subset of plan_covered_services columns (canonical schema is narrower; e.g.,
 * canonical uses `copay`/`coinsurance`/`deductible_applies` for in-network, lacks
 * out-of-network columns + cost_description text). Same single-excerpt rule.
 *
 * Phase 4.0.5: searchedSections propagated for verbatim_absent derivation.
 */
export function buildCanonicalPlanServiceProvenance(
  service: SBCHaikuService,
  source: SourceProvenance = "doc_extraction",
  searchedSections?: string[],
): Record<string, FieldProvenanceEntry> {
  const patternP8 = adaptPatternP8(service.patternP8);
  const haikuConfidence = service.haikuConfidence;

  // canonical_plan_services columns populated from SBC services per process-plan.ts:
  // (canonical_plan_id + concept_id + service_slug are key/identity, NOT provenance-tagged)
  // CF-19c (Session 64): OON columns added (mig 071) — canonical now mirrors plan_covered_services
  // for cost-sharing symmetry. Allows smart-skip to copy OON values from canonical to user rows.
  const fields: Array<[string, unknown]> = [
    ["copay", service.inCopay], // legacy in-network copay column
    ["coinsurance", service.inCoinsurance],
    ["is_covered", service.covered],
    ["requires_prior_auth", service.priorAuthRequired],
    ["deductible_applies", service.inDeductibleApplies],
    ["annual_limit", service.annualLimitValue],
    // CF-19c — OON cost-sharing
    ["out_copay", service.outCopay],
    ["out_coinsurance", service.outCoinsurance],
    ["out_deductible_applies", service.outDeductibleApplies],
  ];

  const provenance: Record<string, FieldProvenanceEntry> = {};
  for (const [column, value] of fields) {
    if (value === null || value === undefined) continue;
    const entry = buildProvenanceEntry(
      "canonical_plan_services",
      column,
      source,
      haikuConfidence,
      patternP8,
      searchedSections,
    );
    if (entry) provenance[column] = entry;
  }
  return provenance;
}

/**
 * Build field_provenance for `insurance_plans` plan-identity columns from an SBC
 * parse result.
 *
 * Per-field patternP8 (each `SBCPlanField<T>` carries its own — plan-identity scalars
 * are extracted independently from the SBC's "Important Questions" section, NOT from
 * a shared row). Legacy fields without patternP8 (e.g., when extraction came from
 * regex fallback) write source + confidence only.
 *
 * Phase 4.0.5: searchedSections propagated for verbatim_absent derivation +
 * targeted re-parse coverage tracking.
 */
export function buildSBCPlanIdentityProvenance(
  planIdentity: SBCPlanIdentity,
  source: SourceProvenance = "doc_extraction",
  searchedSections?: string[],
): Record<string, FieldProvenanceEntry> {
  // Map SBCPlanIdentity field-key → DB column name.
  // Aligns with legacy-adapter.ts:translateHaikuToLegacy() column projection so the
  // provenance keys match what's actually persisted.
  // CF-19c (Session 64): OON plan-identity columns added to mapping. Values come from
  // the SBC's "Important Questions" section's out-of-network deductible/OOP cells.
  const mappings: Array<[string, keyof SBCPlanIdentity]> = [
    ["plan_name", "planName"],
    ["insurer_name", "insurerName"],
    ["plan_type", "planType"],
    ["plan_year", "planYear"],
    ["in_deductible_individual", "deductibleIndividual"],
    ["in_deductible_family", "deductibleFamily"],
    ["in_oop_max_individual", "oopMaxIndividual"],
    ["in_oop_max_family", "oopMaxFamily"],
    ["out_deductible_individual", "outDeductibleIndividual"],
    ["out_deductible_family", "outDeductibleFamily"],
    ["out_oop_max_individual", "outOopMaxIndividual"],
    ["out_oop_max_family", "outOopMaxFamily"],
  ];

  const provenance: Record<string, FieldProvenanceEntry> = {};
  for (const [column, planField] of mappings) {
    const field = planIdentity[planField];
    if (field === null || field === undefined) continue;
    if (field.value === null || field.value === undefined) continue;
    const entry = buildProvenanceEntry(
      "insurance_plans",
      column,
      source,
      field.haikuConfidence,
      adaptPatternP8(field.patternP8),
      searchedSections,
    );
    if (entry) provenance[column] = entry;
  }
  return provenance;
}

/**
 * Build field_provenance for inherited columns when smart-skip copies canonical →
 * user (no Haiku run on the user's actual document).
 *
 * CF-19a (Session 64). Used by extraction-dedup.linkDocumentToCanonical to record
 * "this value came from another Candid user's upload of the same plan, not from
 * extracting your doc directly." Per Pattern 1 #14, written to user-scoped tables
 * only as inheritance pointer; canonical untouched.
 *
 * NO Pattern P-8 sub-keys — smart-skip didn't run Haiku, no source_excerpt.
 * Display layer renders this as "Document Confirmed" (sub-3 corroboration) and
 * promotes to fully "Verified" when canonical's verification_count meets the
 * multiSourceThreshold (compute-on-read in analyze/route.ts). Both states are
 * now in the Session 72 vocabulary — see Candid_10k §3.1.
 *
 * Caller passes (column, value) pairs for fields with non-null values; this helper
 * writes one entry per non-null pair using `source = 'canonical_inherited'`.
 */
export function buildCanonicalInheritedProvenance(
  table: string,
  fields: Array<[string, unknown]>,
): Record<string, FieldProvenanceEntry> {
  const provenance: Record<string, FieldProvenanceEntry> = {};
  for (const [column, value] of fields) {
    if (value === null || value === undefined) continue;
    const entry = buildProvenanceEntry(
      table,
      column,
      "canonical_inherited",
      undefined, // no haiku confidence — we didn't run Haiku
      undefined, // no Pattern P-8 sub-keys — no source_excerpt
      undefined, // no searched_sections — no Haiku dispatch
    );
    if (entry) provenance[column] = entry;
  }
  return provenance;
}

/**
 * Build field_provenance for `insurance_plans` plan-identity columns from an EOC
 * parse result.
 *
 * Q-P3.1A-11 LOCK: EOC parser internally reuses parsePlanDocument() (regex-based)
 * for plan-identity. No patternP8 sub-keys — entries carry source + confidence +
 * last_corroborated_at only. Cross-source corroboration with SBC plan-identity (where
 * values match) lifts confidence via Pattern 1 #3 — corroboration is value-match-based,
 * NOT excerpt-match-based, so absence of P-8 sub-keys here doesn't break the flywheel.
 */
export function buildEOCPlanIdentityProvenance(
  planIdentity: EOCPlanIdentity,
  source: SourceProvenance = "doc_extraction_eoc",
): Record<string, FieldProvenanceEntry> {
  // EOCPlanIdentity field-key already matches DB column name (snake_case throughout).
  const fields: Array<[string, unknown]> = [
    ["plan_name", planIdentity.plan_name],
    ["insurer_name", planIdentity.insurer_name],
    ["plan_year", planIdentity.plan_year],
    ["in_deductible_individual", planIdentity.in_deductible_individual],
    ["in_oop_max_individual", planIdentity.in_oop_max_individual],
    ["out_deductible_individual", planIdentity.out_deductible_individual],
    ["out_oop_max_individual", planIdentity.out_oop_max_individual],
  ];

  const provenance: Record<string, FieldProvenanceEntry> = {};
  for (const [column, value] of fields) {
    if (value === null || value === undefined) continue;
    // No patternP8 — regex extraction. Entry carries source + confidence + timestamp only.
    const entry = buildProvenanceEntry("insurance_plans", column, source);
    if (entry) provenance[column] = entry;
  }
  return provenance;
}
