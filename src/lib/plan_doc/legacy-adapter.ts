/**
 * Translate S72 Haiku-first plan_doc parser output (`PlanDocHaikuParseResult`) to
 * the legacy `PlanDocParseResult` (alias of SBCParseResult) shape used by
 * `process-plan.ts` persistence.
 *
 * Allows additive integration: under `plan_doc_parser_v2` flag ON (commit 3 wiring),
 * new parser produces the same shape downstream code expects. Pattern P-8 sub-keys
 * flow separately to field_provenance JSONB writes (commit 4 — canonical_haiku_extractions
 * writes + dispute-letter cite-grade resolution).
 *
 * Plan_doc-specific data NOT representable in legacy SBCParseResult shape:
 *   - Per-service `howToAccess` field — flows through PlanDocHaikuParseResult to
 *     commit 5 persistence layer (writes to coverage_rules.how_to_access JSONB).
 *     Dropped at this adapter boundary to keep legacy shape unchanged.
 *   - Plan-level `accessInstructions` (customerServicePhone, networkFinderUrl,
 *     domainContacts) — also commit 5 persistence layer (writes to insurance_plans
 *     JSONB metadata). Caller in commit 5 reads the rich PlanDocHaikuParseResult
 *     directly for plan-level access info.
 *
 * Mirrors `src/lib/sbc/legacy-adapter.ts:translateHaikuToLegacy()` pattern.
 */

import type { InsurancePlanInsert } from "@/lib/supabase/types";
import type { SBCParsedService, SBCParseResult } from "../sbc/types";
import type { PlanDocHaikuParseResult } from "./types";

export function toLegacyPlanDocResult(haiku: PlanDocHaikuParseResult): SBCParseResult {
  // Plan-level fields — mirrors SBC legacy-adapter's plan field mapping.
  // CF-19c (Session 64) precedent: OON plan-identity flows through (was hardcoded
  // null pre-Session-64 for SBC; plan_doc Haiku now emits OON values from start).
  const plan: Partial<InsurancePlanInsert> = {
    plan_name: haiku.planIdentity.planName.value,
    insurer_name: haiku.planIdentity.insurerName.value,
    plan_type: haiku.planIdentity.planType.value,
    plan_year: haiku.planIdentity.planYear.value,
    in_deductible_individual: haiku.planIdentity.deductibleIndividual.value,
    in_deductible_family: haiku.planIdentity.deductibleFamily.value,
    in_oop_max_individual: haiku.planIdentity.oopMaxIndividual.value,
    in_oop_max_family: haiku.planIdentity.oopMaxFamily.value,
    out_deductible_individual: haiku.planIdentity.outDeductibleIndividual.value,
    out_deductible_family: haiku.planIdentity.outDeductibleFamily.value,
    out_oop_max_individual: haiku.planIdentity.outOopMaxIndividual.value,
    out_oop_max_family: haiku.planIdentity.outOopMaxFamily.value,
  };

  // Services: strip patternP8/haikuConfidence/howToAccess structured fields. Legacy
  // `sourceExcerpt` field IS preserved for backward compat. howToAccess is dropped
  // at this boundary; commit 5 reads it directly from PlanDocHaikuParseResult for
  // coverage_rules.how_to_access JSONB persistence.
  const services: SBCParsedService[] = haiku.services.map((svc) => ({
    serviceSlug: svc.serviceSlug,
    placeOfService: svc.placeOfService,
    inCopay: svc.inCopay,
    inCoinsurance: svc.inCoinsurance,
    inDeductibleApplies: svc.inDeductibleApplies,
    inCopayWaiverCondition: svc.inCopayWaiverCondition,
    inCostDescription: svc.inCostDescription,
    outCopay: svc.outCopay,
    outCoinsurance: svc.outCoinsurance,
    outDeductibleApplies: svc.outDeductibleApplies,
    outCostDescription: svc.outCostDescription,
    oonPaidAtInNetwork: svc.oonPaidAtInNetwork,
    annualLimit: svc.annualLimit,
    annualLimitValue: svc.annualLimitValue,
    priorAuthRequired: svc.priorAuthRequired,
    penaltyNoPrecert: svc.penaltyNoPrecert,
    covered: svc.covered,
    coverageConditions: svc.coverageConditions,
    supplyLimitDays: svc.supplyLimitDays,
    homeDeliveryCopay: svc.homeDeliveryCopay,
    stepTherapyRequired: svc.stepTherapyRequired,
    notes: svc.notes,
    confidence: svc.confidence,
    sourceExcerpt: svc.sourceExcerpt ?? svc.patternP8.source_excerpt ?? null,
    sourcePage: svc.sourcePage ?? null,
  }));

  // Average confidence across services — matches SBC adapter pattern.
  const avgConfidence =
    services.length > 0
      ? services.reduce((s, x) => s + x.confidence, 0) / services.length
      : 0.5;

  return {
    plan,
    services,
    confidence: avgConfidence,
    parseWarnings: haiku.parseWarnings,
  };
}
