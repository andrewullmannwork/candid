/**
 * Translate Phase 3.2 Haiku-first SBC parser output (`SBCHaikuParseResult`) to
 * the legacy SBC parse-result shape used by `process-plan.ts` persistence.
 *
 * Allows additive integration: under `sbc_parser_v1` flag ON, new parser produces
 * the same shape downstream code expects. Pattern P-8 sub-keys flow separately to
 * field_provenance JSONB writes (deferred to Phase 3.2.1 follow-up to keep this
 * PR scope tight; the in-memory P-8 emission is empirically validated via harness
 * before persistence wiring lands).
 */

import type { InsurancePlanInsert } from "@/lib/supabase/types";
import type {
  SBCParseResult,
  SBCParsedService,
  SBCParsedAppealsContact,
  SBCHaikuParseResult,
} from "./types";

interface LegacyParseResultWithAppealsContact extends SBCParseResult {
  appealsContact: SBCParsedAppealsContact | null;
}

export function translateHaikuToLegacy(haiku: SBCHaikuParseResult): LegacyParseResultWithAppealsContact {
  // Plan-level fields
  // CF-19c (Session 64): OON plan-identity now flows through legacy adapter (was
  // hardcoded null pre-Session-64; SBC Haiku Important Questions prompt now extracts
  // out-of-network deductibles/OOP maxes alongside in-network).
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

  // Services: combine common-medical-events + other-covered (both Haiku-extracted from
  // SBC document; both go into plan_covered_services). Strip the patternP8/haikuConfidence
  // structured fields — they're not part of the legacy SBCParsedService shape, but the
  // legacy `sourceExcerpt` field IS preserved for backward compat.
  const allServices: SBCParsedService[] = [...haiku.services, ...haiku.otherCoveredServices].map((svc) => ({
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

  // Appeals contact: pick first contact (multi-category support deferred to v1.5)
  const firstContact = haiku.appealsContacts[0];
  const appealsContact: SBCParsedAppealsContact | null = firstContact
    ? {
        addressLine1: firstContact.addressLine1,
        addressLine2: firstContact.addressLine2,
        city: firstContact.city,
        state: firstContact.state,
        postalCode: firstContact.postalCode,
        phone: firstContact.phone,
        sourceExcerpt: firstContact.sourceExcerpt,
        sourcePage: firstContact.sourcePage,
        confidence: firstContact.confidence,
      }
    : null;

  // Aggregate confidence: avg of all per-service confidences if any, else 0.5
  const confidences = allServices.map((s) => s.confidence).filter((c) => typeof c === "number");
  const avgConfidence =
    confidences.length > 0 ? confidences.reduce((s, c) => s + c, 0) / confidences.length : 0.5;

  return {
    plan,
    services: allServices,
    confidence: avgConfidence,
    parseWarnings: haiku.parseWarnings,
    appealsContact,
    // CF-63 RC-4 (S128): surface metalTier alongside plan-identity. NOT on the
    // `plan` object because insurance_plans schema has no metal_tier column;
    // routed separately into canonical_plans.metal_level via process-plan.ts
    // → findOrCreateCanonicalPlan call.
    metalTier: haiku.planIdentity.metalTier.value,
  };
}
