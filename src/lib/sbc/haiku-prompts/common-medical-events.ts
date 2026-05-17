/**
 * SBC "Common Medical Events" section — per-service cost-sharing table.
 *
 * The bulk of an SBC document. Extracts ALL service rows from the federal SBC
 * template's main table. Each service gets a Pattern P-8 source_excerpt covering
 * the full table row (one excerpt per service; cost-sharing fields all derive
 * from the same row).
 *
 * Service slug vocabulary: STANDARD_SLUGS (Q-P3.2-8 LOCK — curated SBC-relevant
 * subset of service_catalog). Slugs not in this list logged as warning + dropped
 * post-extraction (concept-resolver.ts).
 */

import type { ExtractionMethod } from "../../parser/types";
import { callHaikuWithCache } from "@/lib/haiku-client/base";
import type { SBCHaikuService, SBCPatternP8Provenance, SBCSectionResult } from "../types";

// SBC parser is being sunset post-S94 (Stage 3 unified dispatch routes all
// sbc/eoc/plan_document uploads through plan_doc parser when
// `unified_plan_doc_parser_v1` flag is ON). This list is kept aligned with the
// 68-slug canonical vocabulary from S94 B1 for consistency during the sunset
// window. Source of truth: plans/s94_unified_parser_meet_or_beat.md.
const STANDARD_SLUGS = [
  // office_visit (5)
  "pcp_visit", "specialist_visit", "home_health", "telehealth_pcp", "telehealth_specialist",
  // preventive (13)
  "preventive_care", "immunizations", "annual_physical", "cancer_screening",
  "adult_dental_care", "childrens_dental_checkup", "childrens_eye_exam",
  "childrens_glasses", "routine_eye_care_adult", "weight_loss_programs",
  "vision_exam", "vision_hardware", "dental_orthodontic",
  // emergency (5)
  "er_visit", "urgent_care", "emergency_transport_ground", "emergency_transport_air",
  "non_emergency_care_outside_us",
  // hospital (6)
  "inpatient_facility", "inpatient_physician", "outpatient_surgery_facility",
  "outpatient_surgery_physician", "bariatric_surgery", "cosmetic_surgery",
  // imaging (3)
  "advanced_imaging", "diagnostic_test", "imaging_basic",
  // lab (1)
  "lab_outpatient",
  // rx (9)
  "generic_rx_tier1", "generic_rx_tier1_90day", "preferred_brand_rx_tier2",
  "preferred_brand_rx_90day", "non_preferred_rx_tier3", "non_preferred_rx_90day",
  "specialty_rx_tier4", "preventive_rx", "chemotherapy_rx",
  // therapy (9)
  "pt_rehab", "ot_rehab", "speech_therapy", "chiropractic", "acupuncture",
  "habilitation", "nutritional_counseling", "routine_foot_care", "cardiac_rehab",
  // mental_health (4)
  "mental_health_outpatient", "mental_health_inpatient",
  "substance_abuse_outpatient", "substance_abuse_inpatient",
  // maternity (5)
  "prenatal_visit", "delivery_facility", "delivery_professional",
  "infertility_treatment", "well_baby",
  // long_term_care (5)
  "hospice_inpatient", "hospice_outpatient", "long_term_care",
  "private_duty_nursing", "skilled_nursing",
  // dme (2)
  "durable_medical_equipment", "hearing_aids",
  // other (1)
  "childrens_dental",
];

const INSTRUCTIONS = `You are extracting per-service cost-sharing rows from the "Common Medical Events" section of a Summary of Benefits and Coverage (SBC) document. Return a single JSON array with one entry per service row.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per service (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text. If you cannot quote verbatim, set source_excerpt to "" (empty).

   **CRITICAL FOR TABULAR SBC CONTENT**: pdftotext extraction interleaves table cells across lines. A single service row's cost-sharing info is typically split across MULTIPLE LINES (e.g., "Primary care visit to treat" on one line, "$30 copay/visit" on another, "50% coinsurance" on a third). DO NOT try to reconstruct multi-line rows into one quote — that will NOT match verbatim. Quote a SINGLE LINE from the source that contains the most distinctive value (preferably the line with the in-network cost-sharing). Short verbatim quotes are correct; long reconstructed paraphrases are wrong. Examples below.
2. **Extract EVERY service row** in the table — even if cost-sharing is identical to a row above. Do not deduplicate.
3. **serviceSlug** MUST be one of the STANDARD_SLUGS below. If a service description doesn't match any slug, omit the row (do NOT invent slugs).
4. **Cost values**:
   - inCopay / outCopay: dollar amount as INTEGER (e.g., 30 for "$30 copay/visit"). Null if coinsurance only or not present.
   - inCoinsurance / outCoinsurance: percentage as DECIMAL (e.g., 0.20 for "20% coinsurance"). Null if copay only.
   - inDeductibleApplies / outDeductibleApplies: true if "after deductible"; false if "no charge" or "deductible doesn't apply"; null if unclear.
   - inCostDescription / outCostDescription: VERBATIM text from the table cell (e.g., "$30 copay/visit", "30% coinsurance after deductible").
5. **placeOfService**: usually "office" or "facility" — null if unclear.
6. **priorAuthRequired**: true if SBC explicitly notes pre-cert/PA required; false if explicitly says no PA; null if absent.
7. **annualLimit**: verbatim text of any annual visit/dollar limit (e.g., "Up to 30 visits/year"). Null if no limit.
8. **covered**: false if "Not Covered"; true otherwise.
9. **coverageConditions**: verbatim text of any qualifying conditions or restrictions.
10. **DO NOT extract** from glossary or coverage example text.
11. **source_section_hint**: always "common_medical_events".

## STANDARD_SLUGS (use exact slug names; omit row if no match):

${STANDARD_SLUGS.join(", ")}

## RESPONSE SCHEMA

{
  "services": [
    {
      "serviceSlug": "pcp_visit",
      "placeOfService": "office",
      "inCopay": 30,
      "inCoinsurance": null,
      "inDeductibleApplies": false,
      "inCopayWaiverCondition": null,
      "inCostDescription": "$30 copay/visit",
      "outCopay": null,
      "outCoinsurance": 0.50,
      "outDeductibleApplies": true,
      "outCostDescription": "50% coinsurance",
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
      "source_excerpt": "Primary care visit to treat an injury or illness $30 copay/visit 50% coinsurance",
      "source_section_hint": "common_medical_events",
      "haiku_confidence": 0.94
    }
  ]
}

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation. Preferred over wrong excerpts.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

### Single-line tabular row (rare; some SBCs use this)
Source: "Primary care visit to treat an injury or illness | $30 copay/visit; deductible doesn't apply | 50% coinsurance | None"

❌ INCORRECT (paraphrased): "PCP visit costs $30"
✅ CORRECT (verbatim row span): "Primary care visit to treat an injury or illness | $30 copay/visit; deductible doesn't apply | 50% coinsurance"

### Multi-line tabular row (MOST SBCs after pdftotext)
Source (pdftotext extraction of tabular SBC):
"Primary care visit to treat
$30 copay/visit; deductible doesn't apply
an injury or illness
50% coinsurance"

❌ INCORRECT (reconstructed multi-line): "Primary care visit to treat an injury or illness $30 copay/visit; deductible doesn't apply 50% coinsurance"
Why wrong: spans 4 source lines; verifier will NOT find this as a contiguous substring.

✅ CORRECT (single-line value): "$30 copay/visit; deductible doesn't apply"
Why right: contiguous in source; unique enough to identify this row.

✅ ALSO CORRECT: "Primary care visit to treat"
Why right: identifies the service row even without cost.

The verifier accepts ANY verbatim substring. Pick the line MOST distinctive to this row (usually the cost-sharing line is best because it pairs the value with relevant context).

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawService {
  serviceSlug?: unknown;
  placeOfService?: unknown;
  inCopay?: unknown;
  inCoinsurance?: unknown;
  inDeductibleApplies?: unknown;
  inCopayWaiverCondition?: unknown;
  inCostDescription?: unknown;
  outCopay?: unknown;
  outCoinsurance?: unknown;
  outDeductibleApplies?: unknown;
  outCostDescription?: unknown;
  oonPaidAtInNetwork?: unknown;
  annualLimit?: unknown;
  annualLimitValue?: unknown;
  priorAuthRequired?: unknown;
  penaltyNoPrecert?: unknown;
  covered?: unknown;
  coverageConditions?: unknown;
  supplyLimitDays?: unknown;
  homeDeliveryCopay?: unknown;
  stepTherapyRequired?: unknown;
  notes?: unknown;
  source_excerpt?: unknown;
  haiku_confidence?: unknown;
}

interface RawResponse {
  services?: RawService[];
}

const STANDARD_SLUG_SET = new Set(STANDARD_SLUGS);

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export async function extractCommonMedicalEvents(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
  sectionHint: "common_medical_events" | "other_covered_services" = "common_medical_events",
): Promise<SBCSectionResult<{ services: SBCHaikuService[] }>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: `sbc/${sectionHint}`,
  });

  const warnings = [...result.warnings];
  const services: SBCHaikuService[] = (result.data.services ?? [])
    .map((raw): SBCHaikuService | null => {
      const slug = typeof raw.serviceSlug === "string" ? raw.serviceSlug : "";
      if (!slug) return null;
      if (!STANDARD_SLUG_SET.has(slug)) {
        warnings.push(`unknown_slug_dropped:${slug}`);
        return null;
      }

      const sourceExcerpt = typeof raw.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
      const patternP8: SBCPatternP8Provenance = {
        source_excerpt: sourceExcerpt,
        source_excerpt_verified: "not_found",
        source_excerpt_extraction_method: extractionMethod,
        source_section_hint: sectionHint,
        source_section_verified: false,
      };

      return {
        serviceSlug: slug,
        placeOfService: asString(raw.placeOfService),
        inCopay: asNumber(raw.inCopay),
        inCoinsurance: asNumber(raw.inCoinsurance),
        inDeductibleApplies: asBoolean(raw.inDeductibleApplies),
        inCopayWaiverCondition: asNullableString(raw.inCopayWaiverCondition),
        inCostDescription: asString(raw.inCostDescription),
        outCopay: asNumber(raw.outCopay),
        outCoinsurance: asNumber(raw.outCoinsurance),
        outDeductibleApplies: asBoolean(raw.outDeductibleApplies),
        outCostDescription: asString(raw.outCostDescription),
        oonPaidAtInNetwork: typeof raw.oonPaidAtInNetwork === "boolean" ? raw.oonPaidAtInNetwork : false,
        annualLimit: asNullableString(raw.annualLimit),
        annualLimitValue: asNumber(raw.annualLimitValue),
        priorAuthRequired: asBoolean(raw.priorAuthRequired),
        penaltyNoPrecert: asNumber(raw.penaltyNoPrecert),
        covered: typeof raw.covered === "boolean" ? raw.covered : true,
        coverageConditions: asNullableString(raw.coverageConditions),
        supplyLimitDays: asNumber(raw.supplyLimitDays),
        homeDeliveryCopay: asNumber(raw.homeDeliveryCopay),
        stepTherapyRequired: asBoolean(raw.stepTherapyRequired),
        notes: asNullableString(raw.notes),
        confidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : 0.5,
        sourceExcerpt: sourceExcerpt || null,
        sourcePage: null,
        patternP8,
        haikuConfidence: typeof raw.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
      };
    })
    .filter((s): s is SBCHaikuService => s !== null);

  return {
    section_type: sectionHint,
    section_range: sectionRange,
    data: { services },
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings,
  };
}

export { STANDARD_SLUGS };
