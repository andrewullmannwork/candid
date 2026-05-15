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
  PlanDocSectionHint,
} from "../types";
import type { PlanDocLayout } from "../layout-detector";
import { loadActiveSupplement } from "../prompt-loader";
import { callHaikuWithCache } from "./_shared";

const PROMPT_FILE_PATH = "src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts";

// Federal-SBC tabular-extraction supplement. Federally-mandated SBCs use a tight
// table layout where pdftotext splits cells across consecutive lines. Without
// this instruction, the model attempts to synthesize multi-line table rows
// into one excerpt and the verbatim verifier rejects the synthesis. Mirrors
// src/lib/sbc/haiku-prompts/common-medical-events.ts:81 verbatim guidance.
const FEDERAL_SBC_TABULAR_SUPPLEMENT = `

## FEDERAL-SBC LAYOUT — TABULAR EXTRACTION OVERRIDE (read carefully)

This document is a federal Summary of Benefits and Coverage (SBC). pdftotext
extracts SBC table cells across MULTIPLE LINES — a single service row's
cost-sharing info typically spans 2-3 consecutive lines. Example:

\`\`\`
Primary care visit to treat an injury or illness
$30 copay/visit
50% coinsurance
No charge after deductible has been met
\`\`\`

When extracting verbatim source_excerpt for SBC services:
- Quote a SINGLE LINE from the source containing the most distinctive value
  (preferably the in-network cost-sharing line).
- DO NOT attempt to reconstruct multi-line rows into one excerpt — that will
  fail verbatim verification.
- Short verbatim single-line quotes are CORRECT; long reconstructed paraphrases
  are WRONG.
- It is PERFECTLY ACCEPTABLE for the source_excerpt to NOT include the service
  name as long as it contains the cost value verbatim from the source.

This rule supersedes any default tendency to "include the full context" in
the excerpt.`;

// S93 Stage 5a — supplements load from `parser_prompt_versions` (mig 102) at
// parse time with a 5-min in-process cache. The compile-time const above is
// the fallback when no active DB row exists (initial state pre-tuning) or
// when DB fetch fails. Admin tunes via /admin/parse-quality-tuning (Stage 5c)
// which writes a new active row + busts the cache.
async function buildInstructions(layout: PlanDocLayout | undefined): Promise<string> {
  if (layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant") {
    const supplement = await loadActiveSupplement(
      PROMPT_FILE_PATH,
      "FEDERAL_SBC_TABULAR_SUPPLEMENT",
      FEDERAL_SBC_TABULAR_SUPPLEMENT,
    );
    return BASE_INSTRUCTIONS + supplement;
  }
  return BASE_INSTRUCTIONS;
}

const BASE_INSTRUCTIONS = `You are extracting per-service cost-sharing from a Plan Document services section. Return a single JSON object listing every covered service with cost-sharing fields per service.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt per service** (≤200 chars): a CONTIGUOUS substring of the section text that appears CHARACTER-FOR-CHARACTER in the source. NEVER paraphrase, summarize, reorder, or join non-contiguous pieces. Partial quotes are PERFECTLY ACCEPTABLE — you do NOT need to include both the service name and the cost values. Quote the MOST INFORMATIVE contiguous span ≤200 chars you can find verbatim. Quality over completeness.

**CORRECT** (any of these acceptable — pick the most informative contiguous span you can find verbatim):
- Just the costs: \`"$30 copay/visit"\` or \`"35% coinsurance"\`
- Just the service name line: \`"Primary Care Visit to treat an injury or illness"\`
- A multi-line span including the literal line breaks as they appear in source: \`"$30 copay/visit\\n40% coinsurance"\`
- A complete row ONLY if service name and costs literally appear adjacent in the source text: \`"Primary Care Visit: $30 copay/visit; 40% coinsurance"\`

**INCORRECT** (paraphrased — would fail verification):
> \`"Primary care office visits cost $30 copay in-network with 40% coinsurance out-of-network"\` (synthesized wording)

**INCORRECT** (joined non-contiguous pieces — would fail):
> \`"Primary Care ... $30 copay/visit ... 40% coinsurance"\` (ellipsis or text between costs that's not literally adjacent in source)

**INCORRECT** (added punctuation like pipes or colons that aren't in source):
> \`"Service: $30 | 40%"\` (if the source has these values on separate lines without pipes/colons added by you)

If you genuinely cannot find ANY contiguous verbatim span containing useful information for this service, set source_excerpt to "" (graceful 'not_found' state). Prefer SHORT but verifiable over LONG but synthesized.

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

/**
 * Extract per-service cost-sharing rows from a section's text.
 *
 * S73 (Session 76): accepts sectionHint param for parity with extractPlanIdentity +
 * extractAccessInstructions (multi-section dispatch consistency). For services, the
 * hint is always "services_cost_sharing" — services rows don't appear in other
 * sections by design. Default arg preserved for backward compat.
 *
 * Sub-segmentation: caller (parsePlanDocumentHaiku) splits the services section into
 * line-granularity chunks (max 1200 tokens each) and dispatches sequentially. Each
 * chunk's services array is concatenated + slug-deduped by the combine layer. Fixes
 * Kaiser-style 102+ services token-truncation (Haiku's 8K output budget cap).
 */
export async function extractServicesCostSharing(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  sectionHint: PlanDocSectionHint = "services_cost_sharing",
  layout?: PlanDocLayout,
): Promise<PlanDocSectionResult<{ services: PlanDocService[] }>> {
  const systemPrompt = await buildInstructions(layout);
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt,
    userContent: sectionText,
    sectionLabel:
      layout === "federal_sbc_8page" || layout === "federal_sbc_csr_variant"
        ? "services_cost_sharing_federal_sbc"
        : "services_cost_sharing",
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
        source_section_hint: sectionHint,
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
