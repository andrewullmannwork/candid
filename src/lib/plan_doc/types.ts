/**
 * Plan_doc Haiku-first parser types per S72 Subplan + Phase 3.1A architectural template.
 *
 * Architecture mirrors `src/lib/sbc/` (Phase 3.2 — Session 53) for structural similarity
 * (both parse plan-summary fields + per-service cost-sharing tables) but adds:
 *   - 3 plan-doc-specific sections: plan_identity / services_cost_sharing / access_instructions
 *   - Per-service `howToAccess` field (NEW — populates coverage_rules.how_to_access JSONB)
 *   - Plan-level customer-service contact for access-instructions UI fallback
 *
 * Per Pattern P-6 hard rule: inherits 7 universal mechanisms via `src/lib/haiku-client/base.ts`
 * + Pattern P-8 verifier via `src/lib/parser/verify-source-excerpts.ts`.
 *
 * Output translates to legacy `SBCParseResult` (PlanDocParseResult alias) via
 * `toLegacyPlanDocResult()` adapter at the orchestrator boundary for process-plan.ts
 * persistence compatibility.
 */

import type { PatternP8Provenance as SharedPatternP8Provenance } from "../parser/verify-source-excerpts";
import type { SBCParsedService, SBCParseResult } from "../sbc/types";

/**
 * Plan_doc-specific section hints per Pattern P-8 convention.
 *
 * Suffix `_DO_NOT_EXTRACT` reserved for boilerplate. Plan_doc boilerplate includes:
 *   - Cover page / insurer marketing copy (header)
 *   - Legal disclaimers in footer
 *   - Glossary cross-references that aren't real definitions
 *
 * Plan documents vary widely (5-300 pages); section detection requires Haiku-discovery
 * fallback (per Phase 3.1A Q-P3.1A-4 LOCK pattern) when regex finds <2 priority sections.
 */
export type PlanDocSectionHint =
  | "plan_identity"
  | "services_cost_sharing"
  | "access_instructions"
  | "other"
  | "header_DO_NOT_EXTRACT"
  | "footer_legalese_DO_NOT_EXTRACT"
  | "glossary_DO_NOT_EXTRACT";

/**
 * Plan_doc Pattern P-8 provenance — generic shape parameterized with PlanDocSectionHint.
 */
export type PlanDocPatternP8Provenance = SharedPatternP8Provenance<PlanDocSectionHint>;

/**
 * Per-field plan-level value with Pattern P-8 provenance + Haiku self-confidence.
 * Mirrors SBCPlanField<T>.
 */
export interface PlanDocField<T> {
  value: T;
  patternP8: PlanDocPatternP8Provenance;
  haikuConfidence?: number;
}

/**
 * Plan_doc plan-level scalars from "plan_identity" section (extracted via Haiku).
 * Mirrors SBCPlanIdentity but adds plan_doc-specific fields (groupNumber, networkType)
 * typically present in fuller plan documents but absent from SBCs.
 */
export interface PlanDocPlanIdentity {
  planName: PlanDocField<string | null>;
  insurerName: PlanDocField<string | null>;
  planType: PlanDocField<string | null>;
  metalTier: PlanDocField<string | null>;
  planYear: PlanDocField<number | null>;
  groupNumber: PlanDocField<string | null>;
  networkType: PlanDocField<string | null>;
  // In-network deductibles + OOP maxes
  deductibleIndividual: PlanDocField<number | null>;
  deductibleFamily: PlanDocField<number | null>;
  oopMaxIndividual: PlanDocField<number | null>;
  oopMaxFamily: PlanDocField<number | null>;
  // OON deductibles + OOP maxes (per master plan §S72 OON expansion)
  outDeductibleIndividual: PlanDocField<number | null>;
  outDeductibleFamily: PlanDocField<number | null>;
  outOopMaxIndividual: PlanDocField<number | null>;
  outOopMaxFamily: PlanDocField<number | null>;
}

/**
 * Per-service row with Pattern P-8 provenance.
 * Reuses SBCParsedService base + adds plan_doc-specific fields:
 *   - howToAccess: per-service access instructions (populates coverage_rules.how_to_access JSONB)
 *
 * Pattern P-8 sub-keys are added as a structured `patternP8` property (vs flat
 * `sourceExcerpt` field on legacy shape, which is preserved for backward compat).
 */
export interface PlanDocService extends SBCParsedService {
  patternP8: PlanDocPatternP8Provenance;
  haikuConfidence?: number;
  howToAccess: string | null;
}

/**
 * Plan-level access instructions for the page-level fallback when per-service
 * access info isn't extractable. UI render priority (per master plan §S72):
 *   1. Per-service `coverage_rules.how_to_access` (PlanDocService.howToAccess)
 *   2. Plan-level customerServicePhone / networkFinderUrl (this struct)
 *   3. Generic "Contact your insurer for details" boilerplate (last resort)
 */
export interface PlanDocAccessInstructions {
  customerServicePhone: PlanDocField<string | null>;
  networkFinderUrl: PlanDocField<string | null>;
  // Per-domain contacts (e.g., behavioral_health, prescription_benefits, dental)
  // Stored as a flat record; UI can iterate to surface domain-specific contacts.
  domainContacts: Record<string, string>;
  domainContactsPatternP8: PlanDocPatternP8Provenance | null;
}

/**
 * Per-section sub-result with cost telemetry + warnings. Mirrors EOC/SBC SectionResult.
 */
export interface PlanDocSectionResult<T> {
  section_type: PlanDocSectionHint;
  section_range: { start: number; end: number };
  data: T;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  haiku_cost_usd: number;
  warnings: string[];
}

/**
 * Top-level Plan_doc Haiku parse result.
 *
 * Translated to legacy `SBCParseResult` (PlanDocParseResult alias) for persistence
 * compatibility via `toLegacyPlanDocResult()` adapter. Pattern P-8 sub-keys persist
 * into `field_provenance` JSONB on canonical_plan_services + plan_covered_services
 * (existing column from Phase 3 mig 056).
 *
 * Plan_doc-specific: per-service howToAccess + plan-level accessInstructions populate
 * coverage_rules JSONB columns + insurance_plans JSONB metadata respectively.
 */
export interface PlanDocHaikuParseResult {
  planIdentity: PlanDocPlanIdentity;
  services: PlanDocService[];
  accessInstructions: PlanDocAccessInstructions | null;
  parseWarnings: string[];
  haikuTokensInput: number;
  haikuTokensOutput: number;
  haikuCacheCreateTokens: number;
  haikuCacheReadTokens: number;
  costUsd: number;
  parseStrategyV2: true;
  /**
   * Phase 4.0.5: section-coverage tracking. Lists which PlanDocSectionHints had
   * Haiku dispatch successfully complete during this parse. Drives `verbatim_absent`
   * derivation in verifyPlanDocSourceExcerpts post-pass + `searched_sections`
   * population on FieldProvenanceEntry.
   */
  dispatchedSections: PlanDocSectionHint[];
  /**
   * Diagnostic — which segmentation path produced the section ranges.
   * Mirrors EOCParseResult.segmentation_used (Q-P3.1A-4 LOCK pattern).
   */
  segmentationUsed:
    | "regex_only"
    | "regex_plus_haiku_discovery"
    | "haiku_discovery_only"
    | "preamble_only";
}

/**
 * Legacy alias — PlanDocParseResult is structurally SBCParseResult.
 * Kept for callsite compatibility. Persistence layer (process-plan.ts) reads this shape.
 */
export type PlanDocParseResult = SBCParseResult;
