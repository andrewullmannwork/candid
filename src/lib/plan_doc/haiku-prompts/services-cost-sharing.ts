/**
 * Plan_doc services + cost-sharing Haiku prompt.
 *
 * Extracts per-service rows including OON cost-sharing columns + per-service
 * `howToAccess` field (populates coverage_rules.how_to_access JSONB per master plan §S72).
 * Pattern P-8 source_excerpt per service row covers all cost-sharing fields since they
 * derive from the same source row.
 */

import type { ExtractionMethod } from "../../parser/types";
import type {
  PlanDocService,
  PlanDocSectionResult,
  PlanDocPatternP8Provenance,
} from "../types";
import { callHaikuWithCache } from "./_shared";

const INSTRUCTIONS = `You are extracting per-service cost-sharing from a Plan Document services section. Return a single JSON object listing every covered service with cost-sharing fields per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per service** (≤200 chars): the literal table row or paragraph in the document containing this service's cost-sharing values. CHARACTER-FOR-CHARACTER substring of section text. NEVER paraphrase. If unable, set to "" (graceful 'not_found').

2. **serviceSlug**: snake_case lowercase identifier matching the service category. Use existing canonical slugs where possible: "primary_care", "specialist_visit", "emergency_room", "urgent_care", "preventive_care", "generic_drugs", "preferred_brand_drugs", "non_preferred_brand_drugs", "specialty_drugs", "outpatient_mental_health", "inpatient_mental_health", "outpatient_substance_use", "inpatient_substance_use", "inpatient_hospital_stay", "outpatient_surgery", "imaging_advanced", "imaging_basic", "lab_outpatient", "skilled_nursing_facility", "home_health_care", "hospice", "physical_therapy", "occupational_therapy", "speech_therapy", "chiropractic", "acupuncture", "durable_medical_equipment", "maternity_prenatal", "delivery", "well_baby", "vision_exam", "vision_hardware", "dental_basic", "dental_orthodontic". For uncategorized services, use snake_case based on the service name.

3. **Cost-sharing fields** (in/out network):
   - inCopay / outCopay: integer (USD) | null (null = not specified)
   - inCoinsurance / outCoinsurance: integer (percentage 0-100) | null
   - inDeductibleApplies / outDeductibleApplies: boolean | null
   - inCostDescription / outCostDescription: short verbatim cost-share text (e.g., "$30 copay" or "20% coinsurance after deductible")

4. **Out-of-network fields are MANDATORY when the document includes OON columns**. If document is HMO-only with no OON coverage, set out* fields to null AND outCostDescription to "Not covered". DO NOT default OON to in-network values.

5. **howToAccess**: per-service plan-specific access instructions if the document includes them (e.g., "Prior auth required via 1-800-CIGNA-24" or "Find covered home health agency at mycigna.com/find-care"). null if not specified per service.

6. **priorAuthRequired**: boolean | null. Extract from Limitations/Notes column or per-service prior-auth callouts.

## RESPONSE SCHEMA

{
  "services": [
    {
      "serviceSlug": "primary_care",
      "placeOfService": "office",
      "inCopay": 30,
      "inCoinsurance": null,
      "inDeductibleApplies": false,
      "inCostDescription": "$30 copay per visit",
      "outCopay": null,
      "outCoinsurance": 40,
      "outDeductibleApplies": true,
      "outCostDescription": "40% coinsurance after deductible",
      "oonPaidAtInNetwork": false,
      "annualLimit": null,
      "annualLimitValue": null,
      "priorAuthRequired": false,
      "penaltyNoPrecert": null,
      "covered": true,
      "coverageConditions": null,
      "supplyLimitDays": null,
      "homeDeliveryCopay": null,
      "stepTherapyRequired": null,
      "notes": null,
      "howToAccess": "Find an in-network primary care provider at cigna.com/find-care",
      "source_excerpt": "verbatim ≤200 chars from the document table row",
      "haiku_confidence": 0.92
    }
  ]
}

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawService {
  serviceSlug?: string;
  placeOfService?: string;
  inCopay?: number | null;
  inCoinsurance?: number | null;
  inDeductibleApplies?: boolean | null;
  inCopayWaiverCondition?: string | null;
  inCostDescription?: string;
  outCopay?: number | null;
  outCoinsurance?: number | null;
  outDeductibleApplies?: boolean | null;
  outCostDescription?: string;
  oonPaidAtInNetwork?: boolean;
  annualLimit?: string | null;
  annualLimitValue?: number | null;
  priorAuthRequired?: boolean | null;
  penaltyNoPrecert?: number | null;
  covered?: boolean;
  coverageConditions?: string | null;
  supplyLimitDays?: number | null;
  homeDeliveryCopay?: number | null;
  stepTherapyRequired?: boolean | null;
  notes?: string | null;
  howToAccess?: string | null;
  source_excerpt?: string;
  haiku_confidence?: number;
}

interface RawResponse {
  services?: RawService[];
}

export async function extractServicesCostSharing(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<PlanDocSectionResult<{ services: PlanDocService[] }>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "services_cost_sharing",
  });

  const services: PlanDocService[] = (result.data.services ?? [])
    .map((raw): PlanDocService | null => {
      const slug = typeof raw.serviceSlug === "string" ? raw.serviceSlug.trim() : null;
      if (!slug) return null;
      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const patternP8: PlanDocPatternP8Provenance = {
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: "services_cost_sharing",
        source_section_verified: false,
      };
      return {
        serviceSlug: slug,
        placeOfService: typeof raw.placeOfService === "string" ? raw.placeOfService : "",
        inCopay: typeof raw.inCopay === "number" ? raw.inCopay : null,
        inCoinsurance: typeof raw.inCoinsurance === "number" ? raw.inCoinsurance : null,
        inDeductibleApplies: typeof raw.inDeductibleApplies === "boolean" ? raw.inDeductibleApplies : null,
        inCopayWaiverCondition: typeof raw.inCopayWaiverCondition === "string" ? raw.inCopayWaiverCondition : null,
        inCostDescription: typeof raw.inCostDescription === "string" ? raw.inCostDescription : "",
        outCopay: typeof raw.outCopay === "number" ? raw.outCopay : null,
        outCoinsurance: typeof raw.outCoinsurance === "number" ? raw.outCoinsurance : null,
        outDeductibleApplies: typeof raw.outDeductibleApplies === "boolean" ? raw.outDeductibleApplies : null,
        outCostDescription: typeof raw.outCostDescription === "string" ? raw.outCostDescription : "",
        oonPaidAtInNetwork: raw.oonPaidAtInNetwork === true,
        annualLimit: typeof raw.annualLimit === "string" ? raw.annualLimit : null,
        annualLimitValue: typeof raw.annualLimitValue === "number" ? raw.annualLimitValue : null,
        priorAuthRequired: typeof raw.priorAuthRequired === "boolean" ? raw.priorAuthRequired : null,
        penaltyNoPrecert: typeof raw.penaltyNoPrecert === "number" ? raw.penaltyNoPrecert : null,
        covered: raw.covered !== false,
        coverageConditions: typeof raw.coverageConditions === "string" ? raw.coverageConditions : null,
        supplyLimitDays: typeof raw.supplyLimitDays === "number" ? raw.supplyLimitDays : null,
        homeDeliveryCopay: typeof raw.homeDeliveryCopay === "number" ? raw.homeDeliveryCopay : null,
        stepTherapyRequired: typeof raw.stepTherapyRequired === "boolean" ? raw.stepTherapyRequired : null,
        notes: typeof raw.notes === "string" ? raw.notes : null,
        confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : 0.5,
        sourceExcerpt: sourceExcerpt || null,
        sourcePage: null,
        howToAccess:
          typeof raw.howToAccess === "string" && raw.howToAccess.length > 0 ? raw.howToAccess : null,
        patternP8,
        haikuConfidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((s): s is PlanDocService => s !== null);

  return {
    section_type: "services_cost_sharing",
    section_range: sectionRange,
    data: { services },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}
