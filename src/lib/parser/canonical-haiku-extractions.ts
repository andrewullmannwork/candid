/**
 * Shared writer for `canonical_haiku_extractions` (mig 084) — append-only cite-grade
 * citations table per S72 Subplan + master plan §S72.
 *
 * Closes CF-20 cite-grade gap for smart-skipped users (post-CF-40 v3 dependency):
 * dispute-letter logic falls back to this table when user's own row lacks
 * source_excerpt — pulls citations from any prior cite-grade Haiku run on the same
 * canonical + matching field.
 *
 * Architecture: writes happen in PARSER ORCHESTRATORS (process-plan.ts for SBC +
 * plan_doc; process-eoc.ts for EOC) post-canonical-resolution. The parsers themselves
 * don't write because canonical_plan_id is resolved AFTER parse (parser doesn't know
 * canonical at parse time). This deviates slightly from the Subplan §commit 4 "parsers
 * write" wording — the architecturally correct place is the orchestrator since
 * canonical_plan_id is NOT NULL FK + only known post-resolution.
 *
 * Per-parser row extractors live here (not in their respective parser modules) so
 * the write helper + extractors stay together — single source of truth for the
 * cite-grade table's row shape across all 3 parsers.
 *
 * Filters: only writes rows where source_excerpt_verified === 'verified' AND
 * source_section_verified === true (Pattern P-8 hard rule for cite-grade). Non-cite
 * entries dropped at this boundary — the table's purpose is the dispute-letter
 * cite-grade fallback chain; storing non-cite entries would pollute the cite-grade
 * partial index without enabling any consumer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceExcerptVerified } from "./types";
import type { SBCHaikuParseResult } from "../sbc/types";
import type { EOCParseResult } from "../eoc/types";
import type { PlanDocHaikuParseResult } from "../plan_doc/types";

export type ParserKind = "sbc" | "eoc" | "plan_doc";

export interface CanonicalHaikuExtractionRow {
  serviceSlug: string | null; // NULL for plan-identity fields
  fieldName: string;
  extractedValue: unknown; // any JSONB-serializable
  sourceExcerpt: string | null;
  sourceExcerptVerified: SourceExcerptVerified;
  sourceSectionHint: string;
  sourceSectionVerified: boolean;
}

export interface WriteCanonicalHaikuExtractionsInput {
  canonicalPlanId: string;
  userId: string; // users.id (UUID); look up via firebase_uid if needed
  documentId: string;
  sourceUserDocHash: string | null;
  haikuRunId: string;
  parserKind: ParserKind;
  rows: CanonicalHaikuExtractionRow[];
}

/**
 * Write per-field cite-grade Pattern P-8 extractions to canonical_haiku_extractions.
 * Append-only — every Haiku run adds rows regardless of whether output matches prior
 * runs (forensic divergence tracing). Filters to cite-grade only (verified +
 * section_verified). Non-fatal on insert error — returns warnings array.
 */
export async function writeCanonicalHaikuExtractions(
  supabase: SupabaseClient,
  input: WriteCanonicalHaikuExtractionsInput,
): Promise<{ rowsWritten: number; warnings: string[] }> {
  const warnings: string[] = [];

  const citeGradeRows = input.rows.filter(
    (r) =>
      r.sourceExcerptVerified === "verified" && r.sourceSectionVerified === true,
  );

  if (citeGradeRows.length === 0) {
    return {
      rowsWritten: 0,
      warnings: [
        `canonical_haiku_extractions:no_cite_grade_rows:${input.parserKind}:${input.haikuRunId}`,
      ],
    };
  }

  const insertRows = citeGradeRows.map((r) => ({
    canonical_plan_id: input.canonicalPlanId,
    service_slug: r.serviceSlug,
    field_name: r.fieldName,
    user_id: input.userId,
    document_id: input.documentId,
    source_user_doc_hash: input.sourceUserDocHash,
    haiku_run_id: input.haikuRunId,
    parser_kind: input.parserKind,
    extracted_value: r.extractedValue,
    source_excerpt: r.sourceExcerpt,
    source_excerpt_verified: r.sourceExcerptVerified,
    source_section_hint: r.sourceSectionHint,
    source_section_verified: r.sourceSectionVerified,
  }));

  const { error } = await supabase
    .from("canonical_haiku_extractions")
    .insert(insertRows);

  if (error) {
    warnings.push(
      `canonical_haiku_extractions_insert_failed:${input.parserKind}:${input.haikuRunId}:${error.message}`,
    );
    return { rowsWritten: 0, warnings };
  }

  return { rowsWritten: insertRows.length, warnings };
}

/**
 * Generate a unique haiku_run_id per Haiku call. Format:
 * `<parserKind>_<documentId>_<unixMillis>`. Combined with the
 * (canonical_plan_id, service_slug, field_name) index, lets dispute-letter
 * resolution fetch the most-recent cite-grade extraction for a given canonical+field
 * via `ORDER BY created_at DESC LIMIT 1`.
 */
export function generateHaikuRunId(
  parserKind: ParserKind,
  documentId: string,
): string {
  return `${parserKind}_${documentId}_${Date.now()}`;
}

// ── Per-parser row extractors ───────────────────────────────────────────────

/**
 * Walk SBCHaikuParseResult and emit cite-grade rows for canonical_haiku_extractions.
 * Covers planIdentity scalars (15 fields) + per-service rows (single P-8 per service
 * covers all cost-sharing fields).
 *
 * Excluded services list (single P-8 for the whole list) is intentionally NOT
 * emitted — dispute-letter logic doesn't cite excluded-services lists; if a future
 * consumer needs them, add here.
 */
export function extractRowsFromSBCHaikuResult(
  haiku: SBCHaikuParseResult,
): CanonicalHaikuExtractionRow[] {
  const rows: CanonicalHaikuExtractionRow[] = [];

  // Plan-identity scalars
  const planFieldMap: Record<string, keyof SBCHaikuParseResult["planIdentity"]> = {
    plan_name: "planName",
    insurer_name: "insurerName",
    plan_type: "planType",
    metal_tier: "metalTier",
    plan_year: "planYear",
    in_deductible_individual: "deductibleIndividual",
    in_deductible_family: "deductibleFamily",
    in_oop_max_individual: "oopMaxIndividual",
    in_oop_max_family: "oopMaxFamily",
    out_deductible_individual: "outDeductibleIndividual",
    out_deductible_family: "outDeductibleFamily",
    out_oop_max_individual: "outOopMaxIndividual",
    out_oop_max_family: "outOopMaxFamily",
  };
  for (const [fieldName, key] of Object.entries(planFieldMap)) {
    const field = haiku.planIdentity[key];
    if (!field?.patternP8) continue;
    rows.push({
      serviceSlug: null,
      fieldName,
      extractedValue: field.value,
      sourceExcerpt: field.patternP8.source_excerpt || null,
      sourceExcerptVerified: field.patternP8.source_excerpt_verified,
      sourceSectionHint: field.patternP8.source_section_hint,
      sourceSectionVerified: field.patternP8.source_section_verified,
    });
  }

  // Per-service rows — single P-8 per service represents the whole row's cost-sharing.
  // Emit one row per service with field_name='services_cost_sharing_row' (covers
  // all cost-sharing fields per Pattern P-8 contract — single excerpt covers all).
  for (const svc of haiku.services) {
    if (!svc.patternP8) continue;
    rows.push({
      serviceSlug: svc.serviceSlug,
      fieldName: "services_cost_sharing_row",
      extractedValue: {
        in_copay: svc.inCopay,
        in_coinsurance: svc.inCoinsurance,
        out_copay: svc.outCopay,
        out_coinsurance: svc.outCoinsurance,
      },
      sourceExcerpt: svc.patternP8.source_excerpt || null,
      sourceExcerptVerified: svc.patternP8.source_excerpt_verified,
      sourceSectionHint: svc.patternP8.source_section_hint,
      sourceSectionVerified: svc.patternP8.source_section_verified,
    });
  }
  for (const svc of haiku.otherCoveredServices) {
    if (!svc.patternP8) continue;
    rows.push({
      serviceSlug: svc.serviceSlug,
      fieldName: "services_cost_sharing_row",
      extractedValue: {
        in_copay: svc.inCopay,
        in_coinsurance: svc.inCoinsurance,
        out_copay: svc.outCopay,
        out_coinsurance: svc.outCoinsurance,
      },
      sourceExcerpt: svc.patternP8.source_excerpt || null,
      sourceExcerptVerified: svc.patternP8.source_excerpt_verified,
      sourceSectionHint: svc.patternP8.source_section_hint,
      sourceSectionVerified: svc.patternP8.source_section_verified,
    });
  }

  return rows;
}

/**
 * Walk EOCParseResult and emit cite-grade rows. EOC plan_identity is regex-extracted
 * (no Pattern P-8 sub-keys per Subplan §3 + Q-P3.1A-11 LOCK), so plan_identity rows
 * are excluded. Per-section rows: prior_auth_codes (per code), medical_necessity
 * (per criterion), appeals/cob/eligibility (single block each w/ inline P-8).
 */
export function extractRowsFromEOCParseResult(
  parsed: EOCParseResult,
): CanonicalHaikuExtractionRow[] {
  const rows: CanonicalHaikuExtractionRow[] = [];

  // Section A: prior_auth_codes (per code)
  if (parsed.sections.prior_auth_codes) {
    for (const code of parsed.sections.prior_auth_codes.data.codes) {
      rows.push({
        serviceSlug: null, // codes don't have a service_slug yet (admin queue resolves)
        fieldName: `prior_auth_code:${code.billing_code_type}:${code.billing_code}`,
        extractedValue: { pa_criteria: code.pa_criteria },
        sourceExcerpt: code.source_excerpt || null,
        sourceExcerptVerified: code.source_excerpt_verified,
        sourceSectionHint: code.source_section_hint,
        sourceSectionVerified: code.source_section_verified,
      });
    }
  }

  // Section B: medical_necessity (per criterion)
  if (parsed.sections.medical_necessity) {
    for (const criterion of parsed.sections.medical_necessity.data.criteria) {
      rows.push({
        serviceSlug: criterion.service_slug_hint,
        fieldName: "medical_necessity_criterion",
        extractedValue: { criteria_text: criterion.criteria_text },
        sourceExcerpt: criterion.source_excerpt || null,
        sourceExcerptVerified: criterion.source_excerpt_verified,
        sourceSectionHint: criterion.source_section_hint,
        sourceSectionVerified: criterion.source_section_verified,
      });
    }
  }

  // Section C/D/F (single-block sections w/ inline P-8)
  const singleBlockSections = [
    { key: "appeals_procedures" as const, fieldName: "appeals_procedures_block" },
    { key: "cob_rules" as const, fieldName: "cob_rules_block" },
    { key: "eligibility_rules" as const, fieldName: "eligibility_rules_block" },
  ];
  for (const { key, fieldName } of singleBlockSections) {
    const section = parsed.sections[key];
    if (!section) continue;
    const data = section.data;
    rows.push({
      serviceSlug: null,
      fieldName,
      extractedValue: data,
      sourceExcerpt: data.source_excerpt || null,
      sourceExcerptVerified: data.source_excerpt_verified,
      sourceSectionHint: data.source_section_hint,
      sourceSectionVerified: data.source_section_verified,
    });
  }

  // Section K: definitions (per definition)
  if (parsed.sections.definitions) {
    for (const def of parsed.sections.definitions.data.definitions) {
      rows.push({
        serviceSlug: null,
        fieldName: `definition:${def.term}`,
        extractedValue: { definition_text: def.definition_text },
        sourceExcerpt: def.source_excerpt || null,
        sourceExcerptVerified: def.source_excerpt_verified,
        sourceSectionHint: def.source_section_hint,
        sourceSectionVerified: def.source_section_verified,
      });
    }
  }

  return rows;
}

/**
 * Walk PlanDocHaikuParseResult and emit cite-grade rows. Plan_identity scalars
 * (15 fields) + per-service rows (single P-8 per service) + access-instructions
 * (3 P-8 entries: customerServicePhone, networkFinderUrl, domainContacts).
 */
export function extractRowsFromPlanDocHaikuResult(
  haiku: PlanDocHaikuParseResult,
): CanonicalHaikuExtractionRow[] {
  const rows: CanonicalHaikuExtractionRow[] = [];

  const planFieldMap: Record<string, keyof PlanDocHaikuParseResult["planIdentity"]> = {
    plan_name: "planName",
    insurer_name: "insurerName",
    plan_type: "planType",
    metal_tier: "metalTier",
    plan_year: "planYear",
    group_number: "groupNumber",
    network_type: "networkType",
    in_deductible_individual: "deductibleIndividual",
    in_deductible_family: "deductibleFamily",
    in_oop_max_individual: "oopMaxIndividual",
    in_oop_max_family: "oopMaxFamily",
    out_deductible_individual: "outDeductibleIndividual",
    out_deductible_family: "outDeductibleFamily",
    out_oop_max_individual: "outOopMaxIndividual",
    out_oop_max_family: "outOopMaxFamily",
  };
  for (const [fieldName, key] of Object.entries(planFieldMap)) {
    const field = haiku.planIdentity[key];
    if (!field?.patternP8) continue;
    rows.push({
      serviceSlug: null,
      fieldName,
      extractedValue: field.value,
      sourceExcerpt: field.patternP8.source_excerpt || null,
      sourceExcerptVerified: field.patternP8.source_excerpt_verified,
      sourceSectionHint: field.patternP8.source_section_hint,
      sourceSectionVerified: field.patternP8.source_section_verified,
    });
  }

  // Per-service rows
  for (const svc of haiku.services) {
    if (!svc.patternP8) continue;
    rows.push({
      serviceSlug: svc.serviceSlug,
      fieldName: "services_cost_sharing_row",
      extractedValue: {
        in_copay: svc.inCopay,
        in_coinsurance: svc.inCoinsurance,
        out_copay: svc.outCopay,
        out_coinsurance: svc.outCoinsurance,
        how_to_access: svc.howToAccess,
      },
      sourceExcerpt: svc.patternP8.source_excerpt || null,
      sourceExcerptVerified: svc.patternP8.source_excerpt_verified,
      sourceSectionHint: svc.patternP8.source_section_hint,
      sourceSectionVerified: svc.patternP8.source_section_verified,
    });
  }

  // Access instructions: 3 P-8 entries (customer service phone + network finder URL + domain contacts)
  if (haiku.accessInstructions) {
    const ai = haiku.accessInstructions;
    if (ai.customerServicePhone?.patternP8) {
      rows.push({
        serviceSlug: null,
        fieldName: "customer_service_phone",
        extractedValue: ai.customerServicePhone.value,
        sourceExcerpt: ai.customerServicePhone.patternP8.source_excerpt || null,
        sourceExcerptVerified: ai.customerServicePhone.patternP8.source_excerpt_verified,
        sourceSectionHint: ai.customerServicePhone.patternP8.source_section_hint,
        sourceSectionVerified: ai.customerServicePhone.patternP8.source_section_verified,
      });
    }
    if (ai.networkFinderUrl?.patternP8) {
      rows.push({
        serviceSlug: null,
        fieldName: "network_finder_url",
        extractedValue: ai.networkFinderUrl.value,
        sourceExcerpt: ai.networkFinderUrl.patternP8.source_excerpt || null,
        sourceExcerptVerified: ai.networkFinderUrl.patternP8.source_excerpt_verified,
        sourceSectionHint: ai.networkFinderUrl.patternP8.source_section_hint,
        sourceSectionVerified: ai.networkFinderUrl.patternP8.source_section_verified,
      });
    }
    if (ai.domainContactsPatternP8) {
      rows.push({
        serviceSlug: null,
        fieldName: "domain_contacts",
        extractedValue: ai.domainContacts,
        sourceExcerpt: ai.domainContactsPatternP8.source_excerpt || null,
        sourceExcerptVerified: ai.domainContactsPatternP8.source_excerpt_verified,
        sourceSectionHint: ai.domainContactsPatternP8.source_section_hint,
        sourceSectionVerified: ai.domainContactsPatternP8.source_section_verified,
      });
    }
  }

  return rows;
}

/**
 * Dispute-letter cite-grade fallback query. Looks up canonical_haiku_extractions
 * for a given canonical+service+field tuple and returns the most-recent cite-grade
 * source_excerpt. Used by evidence-resolver.ts when user's own row's Pattern P-8
 * field_provenance lacks excerpt (smart-skip case post-CF-40 v3).
 *
 * Privacy: returns ONLY source_excerpt + source_section_hint (non-PII columns).
 * user_id / document_id / source_user_doc_hash never leak across users by design.
 *
 * Uses service-role supabase client (bypasses RLS user-scoping for cross-user
 * citation queries — RLS is for direct user reads, not dispute-letter logic).
 */
export async function lookupCanonicalCiteGrade(
  supabase: SupabaseClient,
  params: {
    canonicalPlanId: string;
    serviceSlug: string | null;
    fieldName: string;
  },
): Promise<{ sourceExcerpt: string; sourceSectionHint: string } | null> {
  const query = supabase
    .from("canonical_haiku_extractions")
    .select("source_excerpt, source_section_hint")
    .eq("canonical_plan_id", params.canonicalPlanId)
    .eq("field_name", params.fieldName)
    .eq("source_excerpt_verified", "verified")
    .eq("source_section_verified", true)
    .order("created_at", { ascending: false })
    .limit(1);

  // service_slug nullable: separate eq vs is for SQL correctness
  const finalQuery = params.serviceSlug === null
    ? query.is("service_slug", null)
    : query.eq("service_slug", params.serviceSlug);

  const { data, error } = await finalQuery.maybeSingle();
  if (error || !data || !data.source_excerpt) return null;
  return {
    sourceExcerpt: data.source_excerpt,
    sourceSectionHint: data.source_section_hint ?? "",
  };
}
