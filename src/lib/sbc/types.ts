/**
 * SBC parser types per Phase 3.2 Subplan + Q-P3.2-2 LOCK = REPLACE (Haiku-first).
 *
 * Architecture mirrors `src/lib/eoc/` (Phase 3.1A.1) but tuned for SBC's tabular
 * structure. Per Pattern P-6 hard rule: inherits 7 universal mechanisms via
 * `src/lib/haiku-client/base.ts` + Pattern P-8 verifier via
 * `src/lib/parser/verify-source-excerpts.ts`.
 *
 * 5 SBC sections per Q-P3.2-3 LOCK (per-section dispatch from start):
 *   - important_questions: plan-level scalars (deductible, OOP max, network info)
 *   - common_medical_events: per-service cost-sharing table (the bulk)
 *   - other_covered_services: additional benefits list
 *   - excluded_services: list of non-covered items
 *   - appeals_grievances: appeals contact info + procedures
 *
 * Output translates to legacy SBCParseResult (see `process-plan.ts` persistence
 * compatibility) via `toLegacySBCResult()` adapter at the orchestrator boundary.
 */

import type { InsurancePlanInsert } from "@/lib/supabase/types";
import type { PatternP8Provenance as SharedPatternP8Provenance } from "../parser/verify-source-excerpts";

/**
 * Canonical SBC parse result shape (Phase 3.2.1: relocated from src/lib/plan/sbc-parser.ts).
 * Used by the persistence layer (process-plan.ts) as the lingua franca that both the
 * Haiku-first parser (via `translateHaikuToLegacy()`) and downstream consumers speak.
 */
export interface SBCParseResult {
  plan: Partial<InsurancePlanInsert>;
  services: SBCParsedService[];
  confidence: number;
  parseWarnings: string[];
  /**
   * ACA metal tier extracted from SBC plan-identity ("Bronze" / "Silver" /
   * "Gold" / "Platinum" / "Catastrophic"). CF-63 RC-4 (S128): NOT on
   * insurance_plans schema (no column); flows separately into canonical_plans.
   * metal_level via findOrCreateCanonicalPlan → createCanonicalPlan INSERT.
   * Optional for backward compat with consumers that don't read it.
   */
  metalTier?: string | null;
}

/**
 * Per-service row in an SBC parse result. Cost-sharing fields cover both in-network
 * and out-of-network variants. Pattern P-8 source_excerpt + sourcePage support
 * citation-grade dispute letter evidence (Phase 4.5 work; nullable for backward compat).
 */
export interface SBCParsedService {
  serviceSlug: string;
  placeOfService: string;
  inCopay: number | null;
  inCoinsurance: number | null;
  inDeductibleApplies: boolean | null;
  inCopayWaiverCondition: string | null;
  inCostDescription: string;
  outCopay: number | null;
  outCoinsurance: number | null;
  outDeductibleApplies: boolean | null;
  outCostDescription: string;
  oonPaidAtInNetwork: boolean;
  annualLimit: string | null;
  annualLimitValue: number | null;
  priorAuthRequired: boolean | null;
  penaltyNoPrecert: number | null;
  covered: boolean;
  coverageConditions: string | null;
  supplyLimitDays: number | null;
  homeDeliveryCopay: number | null;
  stepTherapyRequired: boolean | null;
  notes: string | null;
  confidence: number;
  // Phase 4.5 — direct-quote citation data for dispute letter evidence block.
  // Populated when the extractor captures the verbatim SBC passage that
  // supports this service's copay/coinsurance values. Nullable for legacy rows.
  sourceExcerpt?: string | null;
  sourcePage?: number | null;
}

/**
 * Phase 6.1 — extracted appeals contact block from SBC / plan document back pages.
 * Flows into insurer-appeals-upsert so the crowdsourced registry stays fresh.
 */
export interface SBCParsedAppealsContact {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  sourceExcerpt: string | null;
  sourcePage: number | null;
  confidence: number;
}

/**
 * SBC-specific section hints per Pattern P-8 convention.
 *
 * Suffix `_DO_NOT_EXTRACT` reserved for boilerplate. SBC boilerplate includes:
 *   - SBC document header (template language, regulatory citations)
 *   - Footer disclaimers (legal language, "no guarantee" boilerplate)
 *   - Coverage examples (synthetic numeric scenarios at end of SBC — narrative-only)
 *
 * Also includes the "uniform glossary" pages found in some bundled SBC PDFs.
 */
export type SBCSectionHint =
  | "important_questions"
  | "common_medical_events"
  | "other_covered_services"
  | "excluded_services"
  | "appeals_grievances"
  | "other"
  | "header_DO_NOT_EXTRACT"
  | "footer_legalese_DO_NOT_EXTRACT"
  | "coverage_examples_DO_NOT_EXTRACT"
  | "uniform_glossary_DO_NOT_EXTRACT";

/**
 * SBC Pattern P-8 provenance — generic shape parameterized with SBCSectionHint.
 */
export type SBCPatternP8Provenance = SharedPatternP8Provenance<SBCSectionHint>;

/**
 * Per-field plan-level value with Pattern P-8 provenance + Haiku self-confidence
 * (`_meta` block per Q-DR-3D-6, METADATA-only per Pattern P-2).
 */
export interface SBCPlanField<T> {
  value: T;
  patternP8: SBCPatternP8Provenance;
  haikuConfidence?: number;
}

/**
 * SBC plan-level scalars from "Important Questions" section (extracted via Haiku).
 * Mirrors fields in `Partial<InsurancePlanInsert>` but with P-8 provenance per field.
 *
 * v1 scope: high-leverage scalars only. Additional fields (HSA-eligibility,
 * pediatric dental embedded, pediatric vision embedded) deferred to v1.5+ per
 * iteration signal.
 */
export interface SBCPlanIdentity {
  planName: SBCPlanField<string | null>;
  insurerName: SBCPlanField<string | null>;
  planType: SBCPlanField<string | null>; // PPO / HMO / EPO / POS / HDHP
  metalTier: SBCPlanField<string | null>; // Bronze / Silver / Gold / Platinum / Catastrophic
  coverageTier: SBCPlanField<string | null>; // individual / individual_family / etc.
  planYear: SBCPlanField<number | null>;
  coveragePeriodStart: SBCPlanField<string | null>; // ISO date
  deductibleIndividual: SBCPlanField<number | null>; // in-network
  deductibleFamily: SBCPlanField<number | null>; // in-network
  oopMaxIndividual: SBCPlanField<number | null>; // in-network
  oopMaxFamily: SBCPlanField<number | null>; // in-network
  // CF-19c (Session 64): out-of-network plan-identity scalars. SBC's "Important Questions"
  // section typically contains both in-network and out-of-network deductible/OOP values
  // side-by-side; previous version dropped the OON values via legacy-adapter hardcoded
  // null. Now extracted + persisted with their own Pattern P-8 provenance.
  outDeductibleIndividual: SBCPlanField<number | null>;
  outDeductibleFamily: SBCPlanField<number | null>;
  outOopMaxIndividual: SBCPlanField<number | null>;
  outOopMaxFamily: SBCPlanField<number | null>;
  rxDeductibleIndividual: SBCPlanField<number | null>;
  rxDeductibleFamily: SBCPlanField<number | null>;
  referralRequired: SBCPlanField<boolean | null>;
  minimumValueStandard: SBCPlanField<boolean | null>;
  // S74.6 D1 — ACA-compliance flag for D2 registry-fallback gate.
  // Same semantics as PlanDocPlanIdentity (default TRUE with basis='unknown'
  // when no explicit signal; user override at plan-upload confirmation page).
  isAcaCompliant: SBCPlanField<boolean | null>;
  acaComplianceBasis: SBCPlanField<string | null>;
}

/**
 * SBC service row with Pattern P-8 provenance.
 *
 * Reuses legacy `SBCParsedService` shape — Pattern P-8 sub-keys are added as a
 * structured `patternP8` property (vs flat `sourceExcerpt` field on legacy shape,
 * which is preserved for backward compat at the persistence boundary).
 *
 * One source_excerpt per service (the full SBC table row) — covers all cost-sharing
 * fields (in/out copay/coinsurance/deductible) since they all derive from the
 * same row. Per-cost-sharing-field excerpts are unnecessary granularity.
 */
export interface SBCHaikuService extends SBCParsedService {
  patternP8: SBCPatternP8Provenance;
  haikuConfidence?: number; // _meta block per Q-DR-3D-6
}

/**
 * SBC appeals contact with Pattern P-8 provenance. Supports multi-grievance-category
 * SBCs (e.g., Blue Shield 2025 fixtures with separate medical/Rx/MHSA/dental
 * grievance categories — annotated in fixture expected.json).
 */
export interface SBCHaikuAppealsContact extends SBCParsedAppealsContact {
  patternP8: SBCPatternP8Provenance;
  category?: string; // e.g., "medical/Rx", "MHSA Participating" — null for single-category SBCs
}

/**
 * Per-section sub-result with cost telemetry + warnings.
 * Mirrors EOC `EOCSectionResult<T>` shape.
 */
export interface SBCSectionResult<T> {
  section_type: SBCSectionHint;
  section_range: { start: number; end: number };
  data: T;
  haiku_input_tokens: number;
  haiku_output_tokens: number;
  haiku_cost_usd: number;
  warnings: string[];
}

/**
 * Top-level SBC Haiku parse result.
 *
 * Translated to legacy `SBCParseResult` for persistence compatibility via
 * `toLegacySBCResult()` adapter (process-plan.ts boundary). Pattern P-8 sub-keys
 * persist into `field_provenance` JSONB on canonical_plan_services + plan_covered_services
 * (existing column from Phase 3 mig 056).
 */
export interface SBCHaikuParseResult {
  planIdentity: SBCPlanIdentity;
  services: SBCHaikuService[];
  excludedServices: string[]; // Simple list (verbatim per fixture excluded_services_list)
  excludedServicesPatternP8: SBCPatternP8Provenance | null;
  otherCoveredServices: SBCHaikuService[]; // Treated identically to common-medical-events services
  appealsContacts: SBCHaikuAppealsContact[]; // Multi-category support
  parseWarnings: string[];
  haikuTokensInput: number;
  haikuTokensOutput: number;
  haikuCacheCreateTokens: number;
  haikuCacheReadTokens: number;
  costUsd: number;
  parseStrategyV2: true; // marker indicating Haiku-first path (vs legacy regex)
  /**
   * Phase 4.0.5 (Q-P4.0.5-2 LOCK): section-coverage tracking. Lists which
   * SBCSectionHints had Haiku dispatch successfully complete during this parse.
   * Sections that dispatched but failed (cost-cap or exception) are excluded.
   * DO_NOT_EXTRACT sections are never dispatched and never appear here.
   *
   * Drives:
   *   - `verbatim_absent` derivation in verifySBCSourceExcerpts post-pass
   *     (when verified='not_found' AND dispatchedSections covers ALL non-
   *     DO_NOT_EXTRACT SBC sections).
   *   - `searched_sections` population on each FieldProvenanceEntry built by
   *     provenance-builders.ts (forward-compat hook from Phase 4.0).
   */
  dispatchedSections: SBCSectionHint[];
}

/**
 * Legacy adapter — produces existing SBCParseResult shape from SBCHaikuParseResult
 * for persistence layer compatibility. Pattern P-8 sub-keys flow separately to
 * field_provenance JSONB write.
 */
export interface SBCParseResultLegacy {
  plan: Record<string, unknown>; // Partial<InsurancePlanInsert>
  services: SBCParsedService[];
  confidence: number;
  parseWarnings: string[];
}
