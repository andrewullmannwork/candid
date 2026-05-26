/**
 * EOC parser types per Phase 3.1A Subplan + DR-3.1A-C.
 *
 * Pattern P-8 inheritance: every text-extracted field carries 5 source_* sub-keys
 * inline (flat shape per Q-DR-3.1A-B-3 LOCK; matches concept_admin_review_queue
 * column shape from mig 061; consumer-read formatting via formatSectionHint()).
 *
 * Pattern P-D inheritance: per-section EOCSectionResult mirrors EOBExtractionMeta
 * shape — section_range + data + cost telemetry + warnings.
 *
 * 6 priority sections per [[plans/findings/eoc_field_differential]] §1.7b:
 * A=prior_auth_codes · B=medical_necessity · C=appeals_procedures
 * D=cob_rules · F=eligibility_rules · K=definitions
 *
 * Sections E (subrogation), G (pharmacy benefit details), H (state-mandated benefits),
 * I (MH parity), J (OON travel), L (benefit limitations detail), M (provider network
 * tier definitions) deferred to Phase 3.2 / Phase 6 / v1.5+ per Subplan §Out of scope.
 */

import type { PatternP8Provenance as SharedPatternP8Provenance } from "../parser/verify-source-excerpts";
import type { EocAcaComplianceData } from "./haiku-prompts/aca-compliance";

/**
 * EOC-specific section hints per Pattern P-8 convention.
 *
 * Suffix `_DO_NOT_EXTRACT` reserved for boilerplate. EOC has fewer boilerplate sections
 * than EOB (no appeal_rights — that's a DATA section here, section C). Boilerplate
 * for EOC: header (cover page text + insurer marketing copy), legal disclaimers in
 * footer, glossary cross-references.
 */
export type EOCSectionHint =
  | "prior_auth_codes" // Section A — billing codes + PA criteria per code
  | "medical_necessity" // Section B — diagnostic + treatment criteria per service
  | "appeals_procedures" // Section C — internal/external timing + IRO + filing methods
  | "cob_rules" // Section D — primary determination + calculation method
  | "eligibility_rules" // Section F — effective date + dependent age + COBRA + special enrollment
  | "definitions" // Section K — legal definitions of medical necessity, emergency, etc.
  | "other"
  | "header_DO_NOT_EXTRACT" // EOC cover page / insurer marketing
  | "footer_legalese_DO_NOT_EXTRACT" // legal disclaimers
  | "glossary_legalese_DO_NOT_EXTRACT"; // glossary cross-references that aren't real definitions

/**
 * Pattern P-8 5-sub-keys inlined per text-extracted field.
 * Same shape as concept_admin_review_queue columns (mig 061).
 *
 * Generic shape lives in `src/lib/parser/verify-source-excerpts.ts`; EOC parameterizes
 * it with `EOCSectionHint`. Re-exported here to preserve existing import paths in
 * EOC haiku-prompts files (which import `PatternP8Provenance` from this module).
 */
export type PatternP8Provenance = SharedPatternP8Provenance<EOCSectionHint>;

/**
 * Section A — Prior Auth Code Lists.
 * Per [[eoc_field_differential]] §1.2 A: typically 5-50 pages of CPT/HCPCS code tables.
 */
export interface PriorAuthCode extends PatternP8Provenance {
  billing_code: string;
  billing_code_type: "CPT" | "HCPCS" | "NDC" | "REV" | "DRG";
  pa_criteria: string | null; // free-form criteria text (may be empty if just listed)
  haiku_confidence?: number;
}

export interface PriorAuthCodesData {
  codes: PriorAuthCode[];
}

/**
 * Section B — Medical Necessity Criteria.
 * Per [[eoc_field_differential]] §1.2 B: diagnostic + treatment criteria per service.
 */
export interface MedicalNecessityCriterion extends PatternP8Provenance {
  service_slug_hint: string | null; // matched to existing service_catalog or null
  criteria_text: string;
  diagnosis_qualifiers: string[]; // ICD-10 codes referenced (stored in coverage_rules.diagnosis_qualifiers JSONB; NOT queued)
  haiku_confidence?: number;
}

export interface MedicalNecessityData {
  criteria: MedicalNecessityCriterion[];
}

/**
 * Section C — Internal/External Appeals Procedures.
 * Per [[eoc_field_differential]] §1.2 C: timing windows, IRO, filing methods.
 * Single block (not array) — most EOCs have one canonical appeals procedure.
 */
export interface AppealsProceduresData extends PatternP8Provenance {
  internal_timing_days: number | null; // standard internal review window (e.g., 30 days)
  internal_urgent_timing_hours: number | null; // urgent review window (e.g., 72 hours)
  external_timing_days: number | null; // external/IRO review window (e.g., 60 days post-internal denial)
  iro_assignment_method: string | null; // free-form description
  filing_methods: string[]; // ['mail', 'fax', 'online_portal', 'phone']
  state_doi_complaint_text: string | null; // free-form state DOI complaint procedure
  full_text: string; // verbatim full section text for citation
  haiku_confidence?: number;
}

/**
 * Section D — Coordination of Benefits.
 * Per [[eoc_field_differential]] §1.2 D: primary/secondary determination + calculation.
 */
export interface COBRulesData extends PatternP8Provenance {
  primary_determination_method:
    | "birthday_rule"
    | "employer_first"
    | "spouse_first"
    | "longer_continuous_coverage"
    | "other"
    | null;
  calculation_method: "non_duplication" | "maintenance_of_benefits" | "coverage_as_primary" | "other" | null;
  full_text: string; // verbatim full section text
  erisa_preempted: boolean | null; // true if plan is ERISA-governed (federal preempts state law)
  haiku_confidence?: number;
}

/**
 * Section F — Eligibility + Effective Date Rules.
 * Per [[eoc_field_differential]] §1.2 F: effective dates, dependent age limits, COBRA, special enrollment.
 */
export interface EligibilityRulesData extends PatternP8Provenance {
  effective_date_rule: string; // e.g., "1st of month after enrollment"
  dependent_age_limit: number | null; // typically 26
  cobra_eligible: boolean | null;
  cobra_max_months: number | null; // 18 / 29 / 36 typical
  special_enrollment_events: string[]; // qualifying life events (marriage, birth, job loss, etc.)
  full_text: string;
  haiku_confidence?: number;
}

/**
 * Section K — Definitions.
 * Per [[eoc_field_differential]] §1.2 K: legal definitions of medical necessity, emergency, etc.
 */
export interface DefinitionEntry extends PatternP8Provenance {
  term: string;
  definition_text: string;
  haiku_confidence?: number;
}

export interface DefinitionsData {
  definitions: DefinitionEntry[];
}

/**
 * Per-section result wrapper. Captures section range + extracted data + cost telemetry +
 * warnings for the empirical harness (Task 3.1A-E) and per-section debugging.
 */
export interface EOCSectionResult<T> {
  section_type: EOCSectionHint;
  /** Character range in raw doc text (half-open; end exclusive). */
  section_range: { start: number; end: number };
  data: T;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  haiku_cost_usd: number;
  warnings: string[];
}

/**
 * Plan identity reused from plan-doc-parser.ts per Q-P3.1A-11 LOCK.
 * EOC parser invokes parsePlanDocument() for plan-level metadata extraction; this
 * type captures the subset we read back for EOCParseResult.plan_identity.
 */
export interface EOCPlanIdentity {
  insurer_name: string | null;
  plan_name: string | null;
  plan_year: number | null;
  in_deductible_individual: number | null;
  in_oop_max_individual: number | null;
  out_deductible_individual: number | null;
  out_oop_max_individual: number | null;
}

/**
 * Combined EOC parse result. Per-section results are optional — Promise.allSettled
 * means individual section failures don't kill the whole parse (Q-DR-3.1A-C-2 LOCK).
 *
 * Cost hard cap: total_cost_usd checked against $1.00 in parseEOC orchestrator
 * (Q-P3.1A-6 LOCK). Soft target $0.30; soft alarm at $0.45.
 */
export interface EOCParseResult {
  plan_identity: EOCPlanIdentity;
  sections: {
    prior_auth_codes?: EOCSectionResult<PriorAuthCodesData>;
    medical_necessity?: EOCSectionResult<MedicalNecessityData>;
    appeals_procedures?: EOCSectionResult<AppealsProceduresData>;
    cob_rules?: EOCSectionResult<COBRulesData>;
    eligibility_rules?: EOCSectionResult<EligibilityRulesData>;
    definitions?: EOCSectionResult<DefinitionsData>;
  };
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  /**
   * Diagnostic — which segmentation path produced the section ranges.
   * - regex_only: regex found ≥2 of 6 priority sections (no Haiku discovery needed)
   * - regex_plus_haiku_discovery: regex found <2; Haiku discovery merged in (Q-P3.1A-4 fallback)
   * - haiku_discovery_only: regex found 0; entire segmentation came from Haiku
   * - preamble_only: no headings matched at all; entire doc is `other` (degenerate)
   */
  segmentation_used: "regex_only" | "regex_plus_haiku_discovery" | "haiku_discovery_only" | "preamble_only";
  /**
   * S74.6 D1 §A.1 — standalone ACA-compliance extraction dispatched against
   * a bounded slice of the cleaned EOC text. Independent of the 6 priority
   * sections because ACA signal appears in cover page / preamble / plan-summary
   * box rather than the diagnostic sections. Null when dispatch failed; null
   * isAcaCompliant/basis when no signal found (persistence layer applies
   * default fallback per Subplan §1 LOCK).
   */
  aca_compliance: EOCSectionResult<EocAcaComplianceData> | null;
  warnings: string[];
  parse_errors: Array<{ section: EOCSectionHint; error: string }>;
  /**
   * Phase 4.0.5: section-coverage tracking. Lists which EOCSectionHints had
   * Haiku dispatch successfully complete during this parse (sections present
   * in `sections` map and not in parse_errors).
   *
   * Drives:
   *   - `verbatim_absent` derivation in verifyEOCSourceExcerpts post-pass
   *     (when verified='not_found' AND dispatchedSections covers ALL non-
   *     DO_NOT_EXTRACT EOC sections).
   *   - `searched_sections` population on each FieldProvenanceEntry built
   *     by provenance-builders.ts (forward-compat hook from Phase 4.0).
   */
  dispatched_sections: EOCSectionHint[];
  /**
   * Ing-H (CF-44, S129). Column-wrap heuristic decision for this parse —
   * score + fire/skip outcome + signal breakdown. Persisted to
   * documents.metadata.column_wrap_decision by the caller for admin
   * observability + heuristic calibration. Undefined when the parser was
   * called from a context that does not pass a heuristic (legacy tests).
   */
  column_wrap_decision?: import("../sbc/column-wrap-detector").ColumnWrapDecision;
}
